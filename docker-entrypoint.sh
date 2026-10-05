#!/bin/sh
# Volumes do Easypanel/Docker nascem como root. Ajusta o dono de /data e
# só então derruba os privilégios para o usuário "node".
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}"
  exec runuser -u node -- "$@"
fi
exec "$@"
