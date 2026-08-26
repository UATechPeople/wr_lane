#!/usr/bin/env bash
# Serve the cabinet UI over HTTPS via the server's Caddy — WITHOUT disturbing any
# other sites. Safe + idempotent: builds the new config in a temp file, validates it,
# backs up the live Caddyfile, then swaps and reloads. Re-running only updates our block.
#
#   sudo ./setup-caddy.sh cabinet.your-domain.com
#   (or set CABINET_DOMAIN in .env and run: sudo ./setup-caddy.sh)
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ] && [ -f .env ]; then set -a; . ./.env; set +a; DOMAIN="${CABINET_DOMAIN:-}"; fi
[ -n "$DOMAIN" ] || { echo "usage: sudo ./setup-caddy.sh <domain>   (or set CABINET_DOMAIN in .env)"; exit 1; }

if ! command -v caddy >/dev/null 2>&1; then
  cat >&2 <<EOF
Caddy is not installed on this server. Either:
  - install Caddy (https://caddyserver.com/docs/install), then re-run this script, or
  - add this to whichever reverse proxy you already run:
        $DOMAIN  ->  http://127.0.0.1:3500
EOF
  exit 1
fi

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
BEGIN="# >>> hidden-numbers (managed) — do not edit inside >>>"
END="# <<< hidden-numbers (managed) <<<"

tmp="$(mktemp)"
# 1. keep the current config, minus any previous managed block of ours
if [ -f "$CADDYFILE" ]; then
  $SUDO awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip{print}' "$CADDYFILE" > "$tmp"
fi
# 2. append a fresh managed block for the cabinet
{
  echo "$BEGIN"
  echo "$DOMAIN {"
  echo "    reverse_proxy 127.0.0.1:3500"
  echo "}"
  echo "$END"
} >> "$tmp"

# 3. validate the RESULT before touching the live file
if ! caddy validate --adapter caddyfile --config "$tmp" >/dev/null 2>&1; then
  echo "ERROR: the resulting Caddyfile is invalid — your live config was NOT changed." >&2
  caddy validate --adapter caddyfile --config "$tmp" || true
  rm -f "$tmp"; exit 1
fi

# 4. back up, swap in, reload
$SUDO mkdir -p "$(dirname "$CADDYFILE")"
[ -f "$CADDYFILE" ] && $SUDO cp "$CADDYFILE" "$CADDYFILE.hidden-numbers.bak"
$SUDO cp "$tmp" "$CADDYFILE"; rm -f "$tmp"
$SUDO systemctl reload caddy 2>/dev/null || $SUDO caddy reload --adapter caddyfile --config "$CADDYFILE"

echo "Done. https://$DOMAIN  ->  cabinet (127.0.0.1:3500). Your other sites were left untouched."
echo "(backup of the previous Caddyfile: $CADDYFILE.hidden-numbers.bak)"
