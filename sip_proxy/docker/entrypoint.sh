#!/bin/sh
set -e

SHARED_DIR="${SHARED_DIR:-/shared}"
CABINET_INTERNAL_URL="${CABINET_INTERNAL_URL:-http://cabinet:3501}"
MODES="ipauth digest direct"
ENABLED=""

upper() { echo "$1" | tr 'a-z' 'A-Z'; }

load_from_cabinet() {
    DECRYPT_KEY="$(cat "$SHARED_DIR/decrypt.key")"
    export DECRYPT_KEY
    CONFIG=""
    TRIES=0
    while [ -z "$CONFIG" ]; do
        CONFIG="$(curl -fsS -m 5 -H "X-Decrypt-Key: $DECRYPT_KEY" "$CABINET_INTERNAL_URL/config/kamailio" 2>/dev/null || true)"
        [ -n "$CONFIG" ] && break
        TRIES=$((TRIES + 1))
        if [ "$TRIES" -ge 30 ]; then
            echo "ERROR: the cabinet did not return the SIP config at $CABINET_INTERNAL_URL/config/kamailio" >&2
            exit 1
        fi
        echo "[entrypoint] waiting for the cabinet ($TRIES)"
        sleep 2
    done

    MY_PUBLIC_IP="$(echo "$CONFIG" | jq -r '.publicIp // empty')"
    DETOKEN_URL="$(echo "$CONFIG" | jq -r --arg d "$CABINET_INTERNAL_URL/detokenize" '.detokenUrl // $d')"
    export MY_PUBLIC_IP DETOKEN_URL CABINET_INTERNAL_URL

    for m in $MODES; do
        M="$(upper "$m")"
        KEY="$(echo "$CONFIG" | jq -r --arg m "$m" '.modes[$m].key // empty')"
        export "TRUNK_${M}_HOST=$(echo "$CONFIG" | jq -r --arg m "$m" '.modes[$m].host // empty')"
        export "TRUNK_${M}_PORT=$(echo "$CONFIG" | jq -r --arg m "$m" '.modes[$m].port // 5060')"
        if [ -n "$KEY" ]; then
            eval HOST="\$TRUNK_${M}_HOST"
            if [ -n "$HOST" ]; then
                ENABLED="$ENABLED $m"
            else
                echo "[entrypoint] WARNING: $m has a key but no carrier host; the mode stays off" >&2
            fi
        fi
    done
    export "TRUNK_DIGEST_USER=$(echo "$CONFIG" | jq -r '.modes.digest.user // empty')"
    export "TRUNK_DIGEST_PASS=$(echo "$CONFIG" | jq -r '.modes.digest.pass // empty')"
    echo "[entrypoint] SIP config taken from the cabinet"
}


if [ "${HN_CONFIG:-}" != "cabinet" ]; then
    echo "ERROR: set HN_CONFIG=cabinet; this image takes its SIP config from the cabinet only" >&2
    exit 1
fi

TRIES=0
while [ ! -s "$SHARED_DIR/decrypt.key" ]; do
    TRIES=$((TRIES + 1))
    if [ "$TRIES" -ge 30 ]; then
        echo "ERROR: $SHARED_DIR/decrypt.key did not appear; is the cabinet running with SHARED_DIR set?" >&2
        exit 1
    fi
    echo "[entrypoint] waiting for the cabinet key ($TRIES)"
    sleep 2
done

load_from_cabinet

MISSING=0
for var in MY_PUBLIC_IP DB_URL DETOKEN_URL; do
    eval val=\$$var
    if [ -z "$val" ]; then
        echo "ERROR: required setting '$var' is empty" >&2
        MISSING=1
    fi
done
[ "$MISSING" = "1" ] && exit 1

DEFINES=""
for m in $ENABLED; do
    DEFINES="$DEFINES -A WITH_$(upper "$m")"
done

DB_FILE="${DB_URL#sqlite://}"
mkdir -p "$(dirname "$DB_FILE")"

sqlite3 "$DB_FILE" <<'SQL'
CREATE TABLE IF NOT EXISTS version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name VARCHAR(32) NOT NULL,
    table_version INT UNSIGNED DEFAULT 0 NOT NULL,
    CONSTRAINT version_table_name_idx UNIQUE (table_name)
);

CREATE TABLE IF NOT EXISTS htable_ipban (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_name VARCHAR(256) DEFAULT '' NOT NULL,
    key_type INT DEFAULT 0 NOT NULL,
    value_type INT DEFAULT 0 NOT NULL,
    key_value VARCHAR(512) DEFAULT '' NOT NULL,
    expires INT DEFAULT 0 NOT NULL
);

INSERT OR IGNORE INTO version (table_name, table_version) VALUES ('htable_ipban', 2);
SQL

BRANCHES="$(echo $ENABLED | tr ' ' ',')"
echo "[entrypoint] Starting Kamailio on ${MY_PUBLIC_IP}:5060 branches: ${BRANCHES:-none}"

exec kamailio -DD -E -e -f /etc/kamailio/kamailio.cfg $DEFINES
