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
#
# ── Discovery tooling ─────────────────────────────────────────────────────────
# services/discoveryService.js shells out to `nmap` for port/service/OS
# detection. It was never installed here before, so isNmapAvailable() always
# returned false and the nmap discovery method silently did nothing.
# nmap's -O/-sS (OS detection / SYN scan) needs raw sockets: this container
# runs as root (no USER directive below) and Docker's default capability set
# already includes CAP_NET_RAW, so no extra --cap-add is needed at `docker run`
# time — but if you run this under a hardened profile that drops capabilities
# (e.g. --cap-drop=ALL, gVisor, or a restrictive Kubernetes securityContext),
# add back CAP_NET_RAW and CAP_NET_ADMIN or nmap will silently fall back to a
# connect() scan with no OS detection.
# ── Database backup tooling ───────────────────────────────────────────────────
# services/backupService.js's buildDatabaseDumpStream() shells out to
# `mysqldump` for the one-click "Backup NetControl Database" feature
# (routes/backup.js's POST /database) — nothing here ever installed it, so
# that feature failed immediately with "mysqldump failed to start: spawn
# mysqldump ENOENT" the first time anyone actually used it.
#
# Alpine dropped the `mysql-client` package name years ago; `mariadb-client`
# is the current apk package that provides the mysqldump/mysql/mysqladmin
# binaries. It talks the MySQL wire protocol and its mysqldump supports every
# flag buildDatabaseDumpStream() passes (--single-transaction, --routines,
# --triggers, --events) against the mysql:8.4 server this compose file runs.
# Caveat worth knowing: MariaDB's mysqldump can occasionally choke on very
# new MySQL-8-only collations/charsets in a CREATE TABLE statement (e.g.
# utf8mb4_0900_ai_ci showing up as an unrecognized default in older
# mariadb-client builds) — not an issue for this project's own schema today,
# but worth remembering if a future migration introduces one and a backup
# starts failing with a collation-related mysqldump error.
RUN apk add --no-cache \
      samba-client \
      samba-common-tools \
      nmap \
      nmap-scripts \
      ca-certificates \
      mariadb-client \
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