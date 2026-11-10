#!/bin/zsh
# Nightly metadata backup (addresses, history, audit chain). Contains NO key material: funds are recovered from the paper recovery phrase only.
set -euo pipefail
OUT=${SPW_BACKUP_DIR:-$HOME/backups/sp-wallet}; mkdir -p "$OUT"; chmod 700 "$OUT"
/opt/homebrew/opt/postgresql@17/bin/pg_dump "$DATABASE_URL" | gzip > "$OUT/sp-wallet-$(date +%Y%m%d-%H%M).sql.gz"
ls -1t "$OUT"/sp-wallet-*.sql.gz | tail -n +31 | xargs -I{} rm -f {}
