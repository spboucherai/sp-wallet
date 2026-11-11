#!/bin/bash
# Local stack for development/e2e: throwaway signer keystore, local Postgres DB "spw_dev", http://localhost:8650.
# Several sessions on one machine: SPW_DEV_PORT (8650; the signer takes the next port unless SPW_DEV_SIGNER_PORT is set), SPW_DEV_DB (spw_dev,
# its public schema is DROPPED), SPW_DEV_DIR (/tmp/spw-dev). The e2e run then needs SPW_E2E_BASE=http://localhost:$SPW_DEV_PORT and the same SPW_DEV_DIR.
set -euo pipefail
cd "$(dirname "$0")/.."
D=${SPW_DEV_DIR:-/tmp/spw-dev}; rm -rf "$D"; mkdir -p "$D"
P=${SPW_DEV_PORT:-8650}; SP=${SPW_DEV_SIGNER_PORT:-$((P + 1))}; DB=${SPW_DEV_DB:-spw_dev}
export SPW_SIGNER_DIR="$D/signer" SPW_SIGNER_WRAP_KEY="$D/wrap/wrap.key" SPW_SIGNER_SECRET=$(openssl rand -hex 32)
export SPW_ORIGIN=http://localhost:$P SPW_RP_ID=localhost SPW_SIGNER_PORT=$SP
node dist/signer.mjs init > "$D/init.json"
node dist/signer.mjs setup-token > "$D/setup-token"
node dist/signer.mjs serve > "$D/signer.log" 2>&1 & echo $! > "$D/signer.pid"
psql -q -d "$DB" -c 'drop schema public cascade; create schema public;' >/dev/null
DATABASE_URL=postgres:///$DB SPW_SIGNER_URL=http://127.0.0.1:$SP SPW_WEB_DIR=$PWD/dist/web PORT=$P SPW_BROADCAST=${SPW_BROADCAST:-off} \
  node dist/api.mjs > "$D/api.log" 2>&1 & echo $! > "$D/api.pid"
for i in $(seq 1 40); do curl -sf http://localhost:$P/api/v1/health/live >/dev/null && break; sleep 0.25; done
echo "stack up: http://localhost:$P  (setup token in $D/setup-token)"
