#!/bin/sh
set -e

REQUIRED="
  MY_PUBLIC_IP
  DB_URL
  MMD_AUTH_USER
  MMD_AUTH_PASS
  PROTON_GW_IP
  PROTON_GW_PORT
  PROTON_TECH_PREFIX
  MMD_GW_IP
  MMD_GW_PORT
  DIDGLOBAL_GW_IP
  DIDGLOBAL_GW_PORT
  DETOKEN_URL
  WEBHOOK_KEY
"

MISSING=0
for var in $REQUIRED; do
    eval val=\$$var
    if [ -z "$val" ]; then
        echo "ERROR: required env var '$var' is not set" >&2
        MISSING=1
    fi
done

if [ "$MISSING" = "1" ]; then
    echo "Aborting: fix missing variables in .env before starting." >&2
    exit 1
fi

echo "[entrypoint] Starting Kamailio on ${MY_PUBLIC_IP}:5060"

exec kamailio -DD -E -e -f /etc/kamailio/kamailio.cfg