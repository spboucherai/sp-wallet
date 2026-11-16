#!/bin/bash
# V11 interface pass — a local stack per work session, safe to run next to others on the same checkout:
#   tests/e2e/ui-stack.sh <name> <port> [nobuild]
# builds the services and the web app under a lock (so two sessions never build `dist/` at the same time), COPIES `dist/` to
# /tmp/spw-ui-<name>/dist and starts the signer and the API from that copy — a later build by someone else does not change
# what this stack serves. Database `spw_dev_ui_<name>` (created if missing; its public schema is DROPPED), throwaway signer
# keystore, broadcast off. Then:  SPW_E2E_BASE=http://localhost:<port> SPW_DEV_DIR=/tmp/spw-ui-<name> pnpm e2e <spec>
# Stop:  SPW_DEV_DIR=/tmp/spw-ui-<name> scripts/dev-stop.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=${1:?name}; P=${2:?port}; SP=$((P + 1)); D=/tmp/spw-ui-$NAME; DB=spw_dev_ui_$NAME; LOCK=/tmp/spw-ui-build.lock
[ -d "$D" ] && SPW_DEV_DIR="$D" scripts/dev-stop.sh || true
rm -rf "$D"; mkdir -p "$D"
for i in $(seq 1 600); do mkdir "$LOCK" 2>/dev/null && break; sleep 1; done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
if [ "${3:-}" != nobuild ]; then node scripts/build.mjs >"$D/build.log" 2>&1 && (cd apps/web && node_modules/.bin/vite build >>"$D/build.log" 2>&1) || { tail -30 "$D/build.log"; exit 1; }; fi
cp -R dist "$D/dist"
rmdir "$LOCK" 2>/dev/null || true; trap - EXIT
psql -lqt | cut -d'|' -f1 | grep -qw "$DB" || createdb "$DB"
export SPW_SIGNER_DIR="$D/signer" SPW_SIGNER_WRAP_KEY="$D/wrap/wrap.key" SPW_SIGNER_SECRET=$(openssl rand -hex 32)
export SPW_ORIGIN=http://localhost:$P SPW_RP_ID=localhost SPW_SIGNER_PORT=$SP
node "$D/dist/signer.mjs" init > "$D/init.json"
node "$D/dist/signer.mjs" setup-token > "$D/setup-token"
node "$D/dist/signer.mjs" serve > "$D/signer.log" 2>&1 & echo $! > "$D/signer.pid"
psql -q -d "$DB" -c 'drop schema public cascade; create schema public;' >/dev/null
DATABASE_URL=postgres:///$DB SPW_SIGNER_URL=http://127.0.0.1:$SP SPW_WEB_DIR=$D/dist/web PORT=$P SPW_BROADCAST=${SPW_BROADCAST:-off} \
  node "$D/dist/api.mjs" > "$D/api.log" 2>&1 & echo $! > "$D/api.pid"
for i in $(seq 1 60); do curl -sf http://localhost:$P/api/v1/health/live >/dev/null && break; sleep 0.25; done
curl -sf http://localhost:$P/api/v1/health/live >/dev/null || { tail -20 "$D/api.log"; exit 1; }
echo "stack up: http://localhost:$P  (SPW_DEV_DIR=$D)"
