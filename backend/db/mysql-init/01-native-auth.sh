#!/bin/bash
# Runs automatically by the official mysql:8.4 image's entrypoint, ONLY on a
# fresh/empty datadir (see docker-compose.yaml's mysql volume) — every
# script in /docker-entrypoint-initdb.d/ gets executed once, right after the
# server first initializes and the MYSQL_USER/MYSQL_DATABASE it creates from
# the compose file's environment.
#
# Why this exists: MySQL 8.4 creates new users with caching_sha2_password by
# default. backend/services/backupService.js's one-click "Backup NetControl
# Database" feature shells out to `mysqldump` — but Alpine's mariadb-client
# package (backend/Dockerfile) doesn't ship the caching_sha2_password plugin
# shared library, so any mysqldump run against a caching_sha2_password
# account fails with "Plugin caching_sha2_password could not be loaded".
# mysql_native_password needs no client-side plugin at all and is what
# mariadb-client's mysqldump/mysql/mysqladmin fully support, so switching
# the app's own DB user to it here (once, automatically, on first boot)
# means fresh deployments never hit this.
#
# NOTE: this only runs against a brand-new datadir. If you already have a
# running MySQL container/volume from before this file existed, run this
# once by hand against your live database instead:
#
#   docker compose exec mysql mysql -uroot -p"$DB_ROOT_PASSWORD" -e \
#     "ALTER USER '$DB_USER'@'%' IDENTIFIED WITH mysql_native_password BY '$DB_PASSWORD'; FLUSH PRIVILEGES;"
set -e

if [ -n "$MYSQL_USER" ]; then
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<-EOSQL
    ALTER USER '$MYSQL_USER'@'%' IDENTIFIED WITH mysql_native_password BY '$MYSQL_PASSWORD';
    FLUSH PRIVILEGES;
EOSQL
  echo "[mysql-init] Switched '$MYSQL_USER'@'%' to mysql_native_password for mariadb-client compatibility."
fi