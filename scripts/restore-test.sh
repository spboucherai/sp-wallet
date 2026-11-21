#!/bin/zsh
# =============================================================================
#                  SP BOUCHER | INFRASTRUCTURE & AUTOMATION
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# Project          : SP Wallet
# File             : scripts/restore-test.sh
# Module           : scripts
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-19
# Last Modified    : 2026-11-19
#
# Author           : Simon-Pierre Boucher
# Position         : Professor of Finance
# Institution      : Université du Québec en Outaouais (UQO)
# Organization     : SP Boucher
# Website          : https://spboucher.ai
# Git              : https://git.spboucher.ai
#
# Preferred Contact: support@spboucher.ai
# Technical Contact: dev@spboucher.ai
# Security/Admin   : admin@spboucher.ai
#
# Copyright (c) 2026
# Simon-Pierre Boucher
# All rights reserved where applicable. This file is governed by the
# applicable project license, copyright notices and relevant law.
# Existing third-party rights and notices remain unaffected.
#
# License          : None specified (no license file in this repository)
#
# Do not embed credentials, private keys, access tokens,
# certificates or confidential personal information.
#
# =============================================================================
# END OF SP BOUCHER SOURCE HEADER
# =============================================================================

# Restore test: proves that a nightly dump can be read back. Restores ONE dump into a throwaway database, checks that the
# tables that matter are there with rows, that the audit chain verifies, then drops the throwaway database.
# It never touches the live database: the target name is generated here and refused if it is the name in DATABASE_URL.
#
#   scripts/restore-test.sh                 # the newest dump of $SPW_BACKUP_DIR (default ~/backups/sp-wallet)
#   scripts/restore-test.sh path/to/dump.sql.gz
#
# Exit 0 and one line "restore test OK …" when the dump is good; non-zero with the reason otherwise.
set -euo pipefail
PG=${SPW_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
DIR=${SPW_BACKUP_DIR:-$HOME/backups/sp-wallet}
DUMP=${1:-$(ls -1t "$DIR"/sp-wallet-*.sql.gz 2>/dev/null | head -1)}
[[ -n "$DUMP" && -s "$DUMP" ]] || { echo "restore test: no dump to test in $DIR" >&2; exit 2; }
gzip -t "$DUMP"
ADMIN=${SPW_RESTORE_ADMIN_URL:-postgres://127.0.0.1/postgres}
NAME="spw_restore_test_$(date +%s)_$$"
LIVE=${DATABASE_URL:-}; [[ "${LIVE##*/}" != "$NAME" ]] || { echo "restore test: refusing to use the live database name" >&2; exit 2; }
TARGET="${ADMIN%/*}/$NAME"
cleanup() { "$PG/psql" -q "$ADMIN" -c "drop database if exists $NAME with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$PG/psql" -q "$ADMIN" -c "create database $NAME" >/dev/null
# roles named in the dump may not exist here (the read-only research role): ownership and grants are not what is being tested
gunzip -c "$DUMP" | grep -v -E '^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) ' | "$PG/psql" -q -v ON_ERROR_STOP=0 "$TARGET" >/dev/null 2>"/tmp/$NAME.err" || true
q() { "$PG/psql" -Atq "$TARGET" -c "$1"; }
for t in audit_events proposals credentials settings deposits; do
  [[ "$(q "select to_regclass('public.$t') is not null")" == "t" ]] || { echo "restore test: table $t missing after restore of $DUMP" >&2; exit 1; }
done
AUDIT=$(q "select count(*) from audit_events"); CREDS=$(q "select count(*) from credentials"); PROPS=$(q "select count(*) from proposals")
[[ "$AUDIT" -gt 0 ]] || { echo "restore test: audit chain empty after restore of $DUMP" >&2; exit 1; }
# the audit chain links every entry to the previous one: seq without a gap, prev = hash of the entry before
BROKEN=$(q "select count(*) from (select seq, prev, lag(hash) over (order by seq) as before, lag(seq) over (order by seq) as bseq from audit_events) x where bseq is not null and (prev is distinct from before or seq <> bseq + 1)")
[[ "$BROKEN" == "0" ]] || { echo "restore test: audit chain does not link in $DUMP ($BROKEN breaks)" >&2; exit 1; }
rm -f "/tmp/$NAME.err"
echo "restore test OK: $(basename "$DUMP") — $AUDIT audit entries (chain links), $PROPS proposals, $CREDS passkeys"
