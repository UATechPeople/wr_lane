#!/bin/sh
set -e

REQUIRED="
  MY_PUBLIC_IP
  DB_URL
  CARRIER_A_AUTH_USER
  CARRIER_A_AUTH_PASS
  CARRIER_C_GW_IP
  CARRIER_C_GW_PORT
  CARRIER_C_TECH_PREFIX
  CARRIER_A_GW_IP
  CARRIER_A_GW_PORT
  CARRIER_B_GW_IP
  CARRIER_B_GW_PORT
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