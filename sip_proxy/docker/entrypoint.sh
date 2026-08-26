#!/bin/sh
set -e

REQUIRED="
  MY_PUBLIC_IP
  DB_URL
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

DB_FILE="${DB_URL#sqlite://}"
mkdir -p "$(dirname "$DB_FILE")"

# The htable module (persistent antifraud ban list) loads/saves this table
# at startup/shutdown and expects it to already exist with this schema.
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

echo "[entrypoint] Starting Kamailio on ${MY_PUBLIC_IP}:5060"

exec kamailio -DD -E -e -f /etc/kamailio/kamailio.cfg