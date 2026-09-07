#!/usr/bin/env bash
# Hidden Numbers — health check. Reads the running stack and reports what would stop
# calls or results from working. Safe to run at any time: it only reads.
set -uo pipefail
cd "$(dirname "$0")"

FAIL=0
WARN=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

head "Configuration"

if [ -f .env ]; then ok ".env is present"; else bad ".env is missing — run ./up.sh once to create it"; fi
if [ -f keys.env ]; then
  set -a; . ./.env 2>/dev/null; . ./keys.env 2>/dev/null; set +a
  [ -n "${FF3_KEY:-}" ] && ok "encryption key is set" || bad "FF3_KEY is empty — tokens cannot be created"
  [ -n "${DECRYPT_KEY:-}" ] && ok "detokenize key is set" || bad "DECRYPT_KEY is empty — the proxy cannot resolve tokens"
  [ -n "${CABINET_PASSWORD:-}" ] && ok "cabinet password is set" || warn "CABINET_PASSWORD is empty — the cabinet is open to anyone who reaches it"
else
  bad "keys.env is missing — run ./up.sh (and back this file up, it holds your encryption keys)"
  set -a; . ./.env 2>/dev/null; set +a
fi

[ -n "${CLIENT_PREFIX:-}" ] && ok "client prefix: $CLIENT_PREFIX" || bad "CLIENT_PREFIX is empty — incoming calls cannot be matched"
[ -n "${MY_PUBLIC_IP:-}" ] && ok "public ip: $MY_PUBLIC_IP" || warn "MY_PUBLIC_IP is empty — up.sh will try to detect it on each start"

head "Carrier trunk"

BRANCHES=0
USABLE=0
check_branch() {
  local name="$1" key="$2" host="$3"
  [ -z "$key" ] && return
  BRANCHES=$((BRANCHES+1))
  if [ -z "$host" ]; then
    warn "$name: key is set but gateway is empty — a call routed here would go nowhere"
  else
    USABLE=$((USABLE+1))
    ok "$name: key set, gateway $host"
  fi
}
check_branch "ipauth" "${TRUNK_IPAUTH_API_KEY:-}" "${TRUNK_IPAUTH_HOST:-}"
check_branch "digest" "${TRUNK_DIGEST_API_KEY:-}" "${TRUNK_DIGEST_HOST:-}"
check_branch "direct" "${TRUNK_DIRECT_API_KEY:-}" "${TRUNK_DIRECT_HOST:-}"
[ "$USABLE" -eq 0 ] && bad "no usable trunk branch — no call can leave this server"
[ "$BRANCHES" -gt 1 ] && warn "$BRANCHES branches hold a key — the key WinRiders sends decides which one is used"

head "Containers"

for svc in cabinet kamailio rtpengine; do
  line=$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep "^$svc " || true)
  if [ -z "$line" ]; then
    [ "$svc" = "rtpengine" ] && warn "$svc is not running — calls connect but stay silent" || bad "$svc is not running"
  else
    state=${line#* }
    [ "$state" = "running" ] && ok "$svc: $state" || bad "$svc: $state"
  fi
done

restarts=$(docker compose ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{.RestartCount}}' 2>/dev/null | awk '$2 > 3 {print $1}' || true)
[ -n "$restarts" ] && warn "restart loops: $restarts" || ok "no restart loops"

rtp_seen=$(docker compose logs kamailio 2>/dev/null | grep -cE "rtpengine instance .* found" || true)
if [ "${rtp_seen:-0}" -gt 0 ]; then
  ok "kamailio sees rtpengine"
else
  warn "kamailio has not reported an rtpengine instance — check the media relay"
fi

head "Cabinet"

health=$(curl -s -m 5 http://127.0.0.1:3500/health 2>/dev/null || true)
case "$health" in
  *'"ok":true'*)
    ok "cabinet answers on :3500"
    version=$(curl -s -m 5 http://127.0.0.1:3500/version 2>/dev/null || true)
    [ -n "$version" ] && ok "version: $version"
    ;;
  *)
    bad "cabinet does not answer on :3500"
    ;;
esac

settings=$(docker compose exec -T cabinet bun -e '
const { Database } = require("bun:sqlite");
const d = new Database(process.env.DB_PATH || "/data/cabinet.sqlite");
const get = (k) => { const r = d.query("select value from settings where key = ?").get(k); return r ? r.value : null; };
const wr = JSON.parse(get("wr_connection") || "{}");
const crm = JSON.parse(get("crm_webhook") || "{}");
const num = d.query("select count(*) c from numbers").get().c;
const pending = d.query("select count(*) c from outbox where delivered_at is null").get().c;
const stale = d.query("select count(*) c from numbers where result is not null and delivery_status is null").get().c;
console.log(JSON.stringify({ wr: !!(wr.baseUrl && wr.slug && wr.apiKey), inbound: !!get("inbound_key"), core: !!get("core_key"), crm: !!(crm.url || crm.urlTemplate), num, pending, stale }));
' 2>/dev/null | tail -1)

if [ -n "$settings" ]; then
  reads() { echo "$settings" | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p"; }
  [ "$(reads wr)" = "true" ] && ok "WinRiders connection filled in" || bad "WinRiders url, slug or api key missing — nothing is sent to WinRiders"
  [ "$(reads inbound)" = "true" ] && ok "key for your CRM is generated" || warn "no inbound key — your CRM cannot post players"
  [ "$(reads core)" = "true" ] && ok "key for WinRiders is generated" || bad "no key for WinRiders — call results will be rejected"
  [ "$(reads crm)" = "true" ] && ok "CRM endpoint configured" || warn "no CRM endpoint — results queue up instead of being delivered"
  ok "numbers stored: $(reads num)"
  [ "$(reads pending)" -gt 0 ] 2>/dev/null && warn "results waiting in the queue: $(reads pending)" || ok "delivery queue is empty"
  [ "$(reads stale)" -gt 0 ] 2>/dev/null && warn "results with no delivery attempt: $(reads stale)" || true
else
  warn "could not read cabinet settings"
fi

head "Result"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m%d problem(s) that stop the service, %d warning(s)\033[0m\n' "$FAIL" "$WARN"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  printf '\033[33mworking, %d warning(s)\033[0m\n' "$WARN"
  exit 0
fi
printf '\033[32meverything looks healthy\033[0m\n'
