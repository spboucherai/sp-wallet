#!/bin/zsh
# =============================================================================
#                  SP BOUCHER | INFRASTRUCTURE & AUTOMATION
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# Project          : SP Wallet
# File             : scripts/backup.sh
# Module           : scripts
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
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

# Nightly metadata backup (addresses, history, audit chain). Contains NO key material: funds are recovered from the paper recovery phrase only.
#
# A dump only takes its final name once pg_dump has succeeded and gzip has verified it: an interrupted run
# (PM2 fires the cron restart a second early and replaces that first run) leaves nothing behind instead of
# an empty file that looks like a backup.
set -euo pipefail
umask 077
OUT=${SPW_BACKUP_DIR:-$HOME/backups/sp-wallet}; mkdir -p "$OUT"; chmod 700 "$OUT"

# One run at a time: the lock is a directory (atomic), dropped on exit; a lock older than an hour is a dead run.
LOCK="$OUT/.backup.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [[ -n $(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null) ]]; then rmdir "$LOCK" && mkdir "$LOCK"; else exit 0; fi
fi
TMP="$OUT/.sp-wallet-$$.sql.gz.part"
trap 'rm -f "$TMP"; rmdir "$LOCK" 2>/dev/null || true' EXIT

/opt/homebrew/opt/postgresql@17/bin/pg_dump "$DATABASE_URL" | gzip > "$TMP"
gzip -t "$TMP"
# A dump of this database is never small: anything under 1 kB is a failed run, not a backup.
[[ $(stat -f %z "$TMP") -ge 1024 ]] || { echo "backup: dump too small, discarded" >&2; exit 1; }
FINAL="$OUT/sp-wallet-$(date +%Y%m%d-%H%M).sql.gz"
mv "$TMP" "$FINAL"

# Housekeeping: empty files left by earlier versions of this script, stale partial files, then keep the 30 latest.
find "$OUT" -maxdepth 1 -name 'sp-wallet-*.sql.gz' -size 0 -delete
find "$OUT" -maxdepth 1 -name '.sp-wallet-*.part' -mmin +120 -delete
ls -1t "$OUT"/sp-wallet-*.sql.gz | tail -n +31 | xargs -I{} rm -f {}

# Optional copy off this node (SPW_BACKUP_REMOTE = an rsync destination, e.g. host:backups/sp-wallet/). A failed
# copy fails the run so that the monitor sees it; the local dump above is already in place.
if [[ -n ${SPW_BACKUP_REMOTE:-} ]]; then
  rsync -a --chmod=F600 "$FINAL" "$SPW_BACKUP_REMOTE"
fi
