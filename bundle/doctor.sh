#!/usr/bin/env bash
set -uo pipefail

HN_DIR="${HN_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
FAIL=0
WARN=0

ok() { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; WARN=$((WARN + 1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

compose() { docker compose --project-directory "$HN_DIR" -f "$HN_DIR/docker-compose.yml" --env-file "$HN_DIR/.env" "$@"; }

section "Containers"
for svc in cabinet kamailio rtpengine; do
  state="$(compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | awk -v s="$svc" '$1 == s {print $2, $3}')"
  if [ -z "$state" ]; then
    bad "$svc is not running"
  elif [ "${state%% *}" != "running" ]; then
    bad "$svc: $state"
  elif [ "$svc" = "cabinet" ] && [ "${state#* }" != "healthy" ]; then
    warn "cabinet is running but not healthy yet (${state#* })"
  else
    ok "$svc: $state"
  fi
done
loops="$(compose ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{.RestartCount}}' 2>/dev/null | awk '$2 > 3 {print $1}')"
[ -n "$loops" ] && warn "restart loops: $loops" || ok "no restart loops"

section "Ports"
published() { [ -n "$(docker ps -q --filter "publish=$1" --filter "label=com.docker.compose.project=hidden-numbers")" ]; }
listening() { command -v ss >/dev/null 2>&1 && ss -Hln"$1" 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$2\$"; }
{ published 3500/tcp || listening t 3500; } && ok "cabinet is published on 3500/tcp" || bad "nothing serves 3500/tcp"
{ published 5060/udp || listening u 5060; } && ok "SIP is published on 5060/udp" || bad "nothing serves 5060/udp"
{ published 5060/tcp || listening t 5060; } && ok "SIP is published on 5060/tcp" || warn "nothing serves 5060/tcp"

section "Kamailio"
start_line="$(compose logs --no-log-prefix kamailio 2>/dev/null | grep 'Starting Kamailio' | tail -1)"
if [ -n "$start_line" ]; then
  ok "${start_line#*Starting Kamailio }"
  case "$start_line" in *"branches: none"*) bad "kamailio accepts no mode; calls from the platform are refused" ;; esac
else
  bad "kamailio never started; see: docker compose logs kamailio"
fi

section "Firewall"
set -a
. "$HN_DIR/.env"
set +a
if [ -n "${CABINET_DOMAIN:-}" ]; then
  web_rules="80/tcp 443/tcp"
else
  web_rules="3500/tcp"
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  rules="$(ufw status 2>/dev/null)"
  for rule in $web_rules "5060/udp" "5060/tcp" "30000:30500/udp"; do
    echo "$rules" | grep -q "^$rule" && ok "ufw allows $rule" || warn "ufw is active and does not allow $rule"
  done
else
  ok "no active ufw firewall on this host; make sure the provider firewall opens ${web_rules// /, }, 5060/udp+tcp and 30000-30500/udp"
fi

if [ -n "${CABINET_DOMAIN:-}" ]; then
  section "Domain"
  if curl -fsS -m 10 -o /dev/null "https://$CABINET_DOMAIN/health" 2>/dev/null; then
    ok "https://$CABINET_DOMAIN answers"
  else
    bad "https://$CABINET_DOMAIN does not answer; the platform cannot deliver call results (see: journalctl -u caddy)"
  fi
fi

section "Cabinet and platform"
report="$(compose exec -T cabinet bun src/cli.ts doctor 2>&1)"
rc=$?
while IFS=$'\t' read -r level text; do
  case "$level" in
    ok) ok "$text" ;;
    warn) warn "$text" ;;
    fail) bad "$text" ;;
    *) [ -n "$level" ] && warn "$level${text:+ $text}" ;;
  esac
done <<<"$report"
[ "$rc" -gt 1 ] && bad "the cabinet doctor could not run"

section "Result"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m%d problem(s) that stop calls, %d warning(s)\033[0m\n' "$FAIL" "$WARN"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  printf '\033[33mworking, %d warning(s)\033[0m\n' "$WARN"
  exit 0
fi
printf '\033[32meverything looks healthy\033[0m\n'
