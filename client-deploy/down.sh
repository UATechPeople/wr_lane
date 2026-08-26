#!/usr/bin/env bash
# Stop the service. By default keeps your data (the token database + keys.env).
#   ./down.sh        stop containers, keep data
#   ./down.sh --wipe stop AND delete all data (token DB volume). Irreversible.
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; [ -f keys.env ] && . ./keys.env; set +a

if [ "${1:-}" = "--wipe" ]; then
  docker compose down -v
  echo "stopped and DATA DELETED (token DB volume removed). keys.env on disk is untouched."
else
  docker compose down
  echo "stopped. data kept. Start again with ./up.sh, or wipe data with ./down.sh --wipe"
fi
