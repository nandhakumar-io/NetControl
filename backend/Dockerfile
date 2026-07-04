FROM node:22-alpine

WORKDIR /app

# ── Windows remote-management tooling ────────────────────────────────────────
# services/winrm.js tries RPC first (via Samba's `net rpc`, over SMB/135/445)
# and falls back to real WinRM (over HTTP/5985 or HTTPS/5986) if RPC fails —
# e.g. RPC ports blocked by firewall, or the device only has WinRM enabled.
#
# - RPC needs Samba's client tools (`net` binary) + a valid smb.conf.
# - WinRM fallback is pure-JS (nodejs-winrm, see package.json) — no system
#   package needed for it beyond outbound network access, but ca-certificates
#   is included in case a device is configured for WinRM over HTTPS (5986).
RUN apk add --no-cache \
      samba-client \
      samba-common-tools \
      ca-certificates \
    && mkdir -p /etc/samba /var/lib/samba/private /var/cache/samba /var/log/samba \
    && { \
         echo '[global]'; \
         echo '    workgroup = WORKGROUP'; \
         echo '    security = user'; \
         echo '    client min protocol = SMB2'; \
         echo '    client max protocol = SMB3'; \
         echo '    client signing = auto'; \
         echo '    client ntlmv2 auth = yes'; \
         echo '    log file = /var/log/samba/%m.log'; \
         echo '    log level = 1'; \
       } > /etc/samba/smb.conf

COPY package*.json .

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node","server.js"]