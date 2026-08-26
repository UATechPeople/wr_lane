#!/usr/bin/env bash
# Generate this client's encryption keys ONCE into keys.env and never regenerate.
# keys.env is NOT part of the bundle archive, so re-running up.sh or re-extracting the
# zip keeps the same keys — the tokens you already created stay decryptable.
# Uses openssl (falls back to /dev/urandom) — no bun/node/python needed.
set -euo pipefail
cd "$(dirname "$0")"

KEYS="keys.env"
if [ -f "$KEYS" ]; then
  echo "keys.env already exists — keeping your existing keys (not regenerating)."
  exit 0
fi

if command -v openssl >/dev/null 2>&1; then
  rnd_hex()  { openssl rand -hex "$1"; }
  rnd_pass() { openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-16; }
else
  rnd_hex()  { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  rnd_pass() { head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-16; }
fi

umask 177
{
  echo "# YOUR encryption keys — generated once on this server. WinRiders never sees them."
  echo "# BACK THIS FILE UP. If you lose it, tokens you already created cannot be decrypted."
  echo "FF3_KEY=$(rnd_hex 16 | tr 'a-f' 'A-F')"
  echo "FF3_TWEAK=$(rnd_hex 8 | tr 'a-f' 'A-F')"
  echo "DECRYPT_KEY=$(rnd_hex 24)"
  echo "CABINET_PASSWORD=$(rnd_pass)"
} > "$KEYS"

echo "Generated keys.env (your encryption keys). Back it up — losing it loses your tokens."
