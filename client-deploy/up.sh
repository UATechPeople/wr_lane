#!/usr/bin/env bash
# Hidden Numbers — one-command deploy (offline).
#   1. generates YOUR OWN encryption keys once (WinRiders never sees them)
#   2. loads the images bundled in images.tar.gz (no registry, no token)
#   3. starts the cabinet + SIP proxy
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "==> created .env from .env.example — fill it in, then run ./up.sh again"
    exit 1
  fi
  echo "ERROR: .env is missing next to this script." >&2
  exit 1
fi

# Updates may introduce settings that an existing .env does not have yet. Add the
# missing ones with their defaults; values already present are never touched.
if [ -f env.defaults ]; then
  ADDED=0
  while IFS='=' read -r KEY VAL; do
    [ -z "${KEY:-}" ] && continue
    case "$KEY" in \#*) continue ;; esac
    grep -q "^[[:space:]]*${KEY}=" .env && continue
    [ "$ADDED" -eq 0 ] && printf '\n# ===== added by update =====\n' >> .env
    echo "${KEY}=${VAL}" >> .env
    ADDED=$((ADDED + 1))
  done < env.defaults
  [ "$ADDED" -gt 0 ] && echo "==> added $ADDED new settings to .env (existing values untouched)"
fi

# 1. generate this server's encryption keys ONCE into keys.env (never regenerated)
./keygen.sh

# 2. load config (.env) + your keys (keys.env)
set -a; . ./.env; [ -f keys.env ] && . ./keys.env; set +a

# auto-detect this server's public IP if not set (kamailio advertises it for SIP)
if [ -z "${MY_PUBLIC_IP:-}" ]; then
  MY_PUBLIC_IP="$(curl -4 -fsS ifconfig.me 2>/dev/null || curl -4 -fsS https://api.ipify.org 2>/dev/null || true)"
  [ -n "$MY_PUBLIC_IP" ] && { export MY_PUBLIC_IP; echo "==> public IP: $MY_PUBLIC_IP"; } \
    || { echo "ERROR: could not auto-detect public IP — set MY_PUBLIC_IP in .env" >&2; exit 1; }
fi

command -v docker >/dev/null || { echo "ERROR: Docker is not installed." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: 'docker compose' not available." >&2; exit 1; }

# 3. load the bundled images (offline — no registry, no token)
if [ -f images.tar.gz ]; then
  echo "==> loading images from images.tar.gz"
  docker load -i images.tar.gz
elif [ -f images.tar ]; then
  echo "==> loading images from images.tar"
  docker load -i images.tar
else
  echo "ERROR: images.tar.gz not found next to this script — offline bundle is incomplete." >&2
  exit 1
fi

echo "==> starting"; docker compose up -d

CAB_PASS="$(grep -E '^CABINET_PASSWORD=' keys.env 2>/dev/null | cut -d= -f2-)"
echo
echo "==> done."
echo "   Cabinet UI:  http://${MY_PUBLIC_IP}:3500   (login: ${CABINET_USER:-admin} / ${CAB_PASS})"
echo "   SIP proxy:   UDP/TCP 5060 (make sure the firewall allows it)"
echo "   Stop:        ./down.sh        Status: docker compose ps"
echo "   HTTPS:       sudo ./setup-caddy.sh <your-domain>   (optional)"
