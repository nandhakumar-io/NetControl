// services/discoveryVendors.js — MAC OUI → vendor lookup
//
// This ships with a small, curated table of common enterprise/network/IoT
// OUI prefixes (first 3 octets of a MAC address) so discovery results are
// useful out of the box with zero external dependencies or network calls.
//
// It is NOT the full IEEE registry (that's 40k+ entries and changes
// constantly). For a complete/current registry, an operator can point
// OUI_CSV_PATH at a local copy of https://standards-oui.ieee.org/oui/oui.csv
// (download it out-of-band — this module never fetches it itself, to avoid
// giving the discovery feature an unexpected outbound network dependency)
// and loadCsvOverrides() will merge it in at boot.
'use strict';

const fs = require('fs');

// prefix (6 hex chars, no separators, uppercase) -> vendor name
const OUI_TABLE = {
  '000C29': 'VMware', '005056': 'VMware', '000569': 'VMware',
  '001C14': 'VMware', 'B4B15A': 'VMware',
  '080027': 'Oracle VirtualBox', '525400': 'QEMU/KVM',
  '00155D': 'Microsoft Hyper-V',
  'DCA632': 'Raspberry Pi', 'B827EB': 'Raspberry Pi', 'E45F01': 'Raspberry Pi',
  '28CDC1': 'Raspberry Pi',
  '3C5AB4': 'Google', 'F4F5D8': 'Google', '54609B': 'Google',
  '3CD92B': 'Hewlett Packard', '9C8E99': 'Hewlett Packard', '001A4B': 'Hewlett Packard',
  '10604B': 'HP Inc.', 'A0481C': 'HP Inc.', '3010B3': 'HP Inc.',
  '0004AC': 'IBM', '00145E': 'Cisco', '000142': 'Cisco',
  '001B54': 'Cisco', '0018BA': 'Cisco', '0022BD': 'Cisco', '00259C': 'Cisco',
  'A0E0AF': 'Cisco', '2C5447': 'Cisco', '689CE2': 'Cisco Meraki',
  '0018E7': 'Cisco Meraki', 'E0553D': 'Cisco Meraki',
  '00E0FC': 'Huawei', '48435A': 'Huawei', '00259E': 'Huawei',
  '001AA9': 'Dell', '0014F2': 'Dell', 'B8CA3A': 'Dell', '18A99B': 'Dell',
  'D4AE05': 'Dell', 'F8B156': 'Dell', '509A4C': 'Dell',
  '00259D': 'Apple', '00CDFE': 'Apple', '000393': 'Apple',
  '3C0754': 'Apple', '7CD1C3': 'Apple', 'A45E60': 'Apple', 'F0DBF8': 'Apple',
  'DC2B2A': 'Apple', '8863DF': 'Apple',
  'F4F26D': 'Ubiquiti Networks', '245A4C': 'Ubiquiti Networks',
  '788A20': 'Ubiquiti Networks', '04180F': 'Ubiquiti Networks',
  'FCECDA': 'Ubiquiti Networks', 'DC9FDB': 'Ubiquiti Networks',
  '000FB5': 'Netgear', '20E52A': 'Netgear', '2C3033': 'Netgear',
  '9C3DCF': 'Netgear', 'A040A0': 'Netgear',
  '001D0F': 'TP-Link', '50C7BF': 'TP-Link', 'EC172F': 'TP-Link',
  'F4EC38': 'TP-Link', 'C46E1F': 'TP-Link',
  '000625': 'Juniper Networks', '2C6BF5': 'Juniper Networks',
  '5C5EAB': 'Juniper Networks', '8CB6C1': 'Juniper Networks',
  '000B86': 'Aruba Networks (HPE)', '24DEC6': 'Aruba Networks (HPE)',
  '9C1C12': 'Aruba Networks (HPE)', '6CF37F': 'Aruba Networks (HPE)',
  '0021B7': 'Extreme Networks', '5CF9DD': 'Extreme Networks',
  '001E58': 'D-Link', '1CBDB9': 'D-Link', 'C8D3A3': 'D-Link',
  '00E04C': 'Realtek', '52540': 'Realtek',
  '001517': 'Intel', '3CA9F4': 'Intel', 'A0369F': 'Intel', 'F8F21E': 'Intel',
  '000AF7': 'Broadcom', 'B4A9FC': 'Broadcom',
  '0016CB': 'Samsung', '5C0A5B': 'Samsung', 'F0728C': 'Samsung',
  '38AA3C': 'Samsung', 'BC1401': 'Samsung',
  '001132': 'Synology', '0011D8': 'Synology', '001132': 'Synology',
  '0090A9': 'QNAP', '245EBE': 'QNAP',
  '00E081': 'ASUSTeK', '049226': 'ASUSTeK', '2C56DC': 'ASUSTeK',
  '000AE4': 'Fortinet', '906CAC': 'Fortinet', '085B0E': 'Fortinet',
  '001217': 'Palo Alto Networks', '007819': 'Palo Alto Networks',
  '000129': 'SonicWALL', '0006B1': 'Sonos',
  '3495DB': 'Sonos', '5CAAFD': 'Sonos',
  '000D93': 'Apple (Airport)', 'B03495': 'Xiaomi', '286C07': 'Xiaomi',
  '689423': 'Amazon Technologies', 'F0272D': 'Amazon Technologies',
  '74C246': 'Amazon Technologies',
  '3C8375': 'Espressif (ESP8266/32 IoT)', '246F28': 'Espressif (ESP8266/32 IoT)',
  '8CAAB5': 'Espressif (ESP8266/32 IoT)', 'A020A6': 'Espressif (ESP8266/32 IoT)',
  '000569': 'VMware',
  '005046': 'Zebra Technologies', '00072C': 'Zebra Technologies',
  '0080F0': 'Panasonic',
  '000E6D': 'Nortel Networks', '000F3D': 'Nortel Networks',
  '0004E2': 'Cisco (older)', '00D0BC': 'Cisco (older)',
  '3417EB': 'Ruckus Wireless', '2C5D93': 'Ruckus Wireless',
};

let _csvOverrides = null;

/** Optionally merge in a full IEEE oui.csv dump if the operator has placed one on disk. */
function loadCsvOverrides(csvPath) {
  if (!csvPath) return;
  try {
    if (!fs.existsSync(csvPath)) return;
    const text = fs.readFileSync(csvPath, 'utf8');
    const map = {};
    for (const line of text.split('\n')) {
      // IEEE format: Registry,Assignment,Organization Name,Organization Address
      const m = line.match(/^[A-Za-z\-]+,([0-9A-Fa-f]{6}),"?([^",]+)"?/);
      if (m) map[m[1].toUpperCase()] = m[2].trim();
    }
    _csvOverrides = map;
    console.log(`[Discovery] Loaded ${Object.keys(map).length} OUI entries from ${csvPath}`);
  } catch (e) {
    console.warn('[Discovery] Failed to load OUI CSV override:', e.message);
  }
}

if (process.env.OUI_CSV_PATH) loadCsvOverrides(process.env.OUI_CSV_PATH);

/**
 * Look up the vendor for a MAC address.
 * @param {string} mac — any common MAC format (colons, dashes, or bare)
 * @returns {string|null}
 */
function lookupVendor(mac) {
  if (!mac) return null;
  const prefix = String(mac).toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
  if (prefix.length < 6) return null;
  if (_csvOverrides && _csvOverrides[prefix]) return _csvOverrides[prefix];
  return OUI_TABLE[prefix] || null;
}

module.exports = { lookupVendor, loadCsvOverrides };
