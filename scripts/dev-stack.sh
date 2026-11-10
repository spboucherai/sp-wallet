#!/bin/bash
# Local stack for development/e2e: throwaway signer keystore, local Postgres DB "spw_dev", http://localhost:8650.
set -euo pipefail
cd "$(dirname "$0")/.."
D=${SPW_DEV_DIR:-/tmp/spw-dev}; rm -rf "$D"; mkdir -p "$D"
export SPW_SIGNER_DIR="$D/signer" SPW_SIGNER_WRAP_KEY="$D/wrap/wrap.key" SPW_SIGNER_SECRET=$(openssl rand -hex 32)
export SPW_ORIGIN=http://localhost:8650 SPW_RP_ID=localhost SPW_SIGNER_PORT=8651
node dist/signer.mjs init > "$D/init.json"
node dist/signer.mjs setup-token > "$D/setup-token"
node dist/signer.mjs serve > "$D/signer.log" 2>&1 & echo $! > "$D/signer.pid"
psql -q -d spw_dev -c 'drop schema public cascade; create schema public;' >/dev/null
DATABASE_URL=postgres:///spw_dev SPW_SIGNER_URL=http://127.0.0.1:8651 SPW_WEB_DIR=$PWD/dist/web PORT=8650 SPW_BROADCAST=${SPW_BROADCAST:-off} \
  node dist/api.mjs > "$D/api.log" 2>&1 & echo $! > "$D/api.pid"
for i in $(seq 1 40); do curl -sf http://localhost:8650/api/v1/health/live >/dev/null && break; sleep 0.25; done
echo "stack up: http://localhost:8650  (setup token in $D/setup-token)"
