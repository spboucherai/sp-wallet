#!/bin/bash
# Rollback rehearsal (docs/V11-DEPLOYMENT.md §9) — start ONE version's bundles on a signer directory and a database that
# another version already used. Unlike scripts/dev-stack.sh it never wipes anything after `init`: that is the point.
#
#   scripts/rollback-rehearsal-stack.sh init  <dist dir>     first start: fresh keystore in $RB_DIR, database $RB_DB emptied
#   scripts/rollback-rehearsal-stack.sh start <dist dir>     start THAT build on the SAME keystore, state and database
#   scripts/rollback-rehearsal-stack.sh stop
#
#   RB_DIR (default /tmp/spw-rollback), RB_DB (default spw_rollback — created if missing), RB_PORT (default 8770; the signer
#   takes the next port). Throwaway keystore, local PostgreSQL, broadcast off, paper only. Extra variables of the environment
#   (SPW_WORKERS, a lock…) are passed through to the API.
set -euo pipefail
cd "$(dirname "$0")/.."
CMD=${1:?init|start|stop}; D=${RB_DIR:-/tmp/spw-rollback}; DB=${RB_DB:-spw_rollback}; P=${RB_PORT:-8770}; SP=$((P + 1))
stop() { for f in "$D"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done; sleep 1; }
if [ "$CMD" = stop ]; then stop; exit 0; fi
DIST=$(cd "${2:?dist directory}" && pwd)
[ -s "$DIST/api.mjs" ] && [ -s "$DIST/signer.mjs" ] || { echo "no api.mjs / signer.mjs in $DIST" >&2; exit 2; }
if [ "$CMD" = init ]; then
  [ -d "$D" ] && stop; rm -rf "$D"; mkdir -p "$D"
  openssl rand -hex 32 > "$D/secret"
  psql -lqt | cut -d'|' -f1 | grep -qw "$DB" || createdb "$DB"
  psql -q -d "$DB" -c 'drop schema public cascade; create schema public;' >/dev/null
else stop; fi
export SPW_SIGNER_DIR="$D/signer" SPW_SIGNER_WRAP_KEY="$D/wrap/wrap.key" SPW_SIGNER_SECRET=$(cat "$D/secret")
export SPW_ORIGIN=http://localhost:$P SPW_RP_ID=localhost SPW_SIGNER_PORT=$SP SPW_DATA_DIR="$D/data"
N=$(ls "$D"/api-*.log 2>/dev/null | wc -l | tr -d ' ')
if [ "$CMD" = init ]; then node "$DIST/signer.mjs" init > "$D/init.json"; node "$DIST/signer.mjs" setup-token > "$D/setup-token"; fi
node "$DIST/signer.mjs" serve > "$D/signer-$N.log" 2>&1 & echo $! > "$D/signer.pid"
sleep 1
DATABASE_URL=postgres:///$DB SPW_SIGNER_URL=http://127.0.0.1:$SP SPW_WEB_DIR=$DIST/web PORT=$P SPW_BROADCAST=off \
  node "$DIST/api.mjs" > "$D/api-$N.log" 2>&1 & echo $! > "$D/api.pid"
for i in $(seq 1 80); do curl -sf "http://localhost:$P/api/v1/health/live" >/dev/null && break; sleep 0.25; done
if curl -sf "http://localhost:$P/api/v1/health/live" >/dev/null; then echo "up: http://localhost:$P from $DIST (logs $D/api-$N.log, $D/signer-$N.log)"
else echo "the API did NOT come up — last lines of $D/api-$N.log:"; tail -15 "$D/api-$N.log"; echo "— signer:"; tail -8 "$D/signer-$N.log"; exit 1; fi
