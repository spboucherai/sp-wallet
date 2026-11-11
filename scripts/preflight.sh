#!/bin/bash
# Pre-flight of a deployment — run on the API node, from the checkout, BEFORE restarting (docs/runbooks/deploy.md).
# READ-ONLY: it changes nothing in the application, its database or the signer. The only thing it creates is a scratch
# database (--db), dropped before it exits. It never prints the value of a variable: names and yes/no only.
#
#   scripts/preflight.sh [--db <database name>] [--env-from-pm2 <pm2 process name>] [--max-backup-hours 36] [--min-free-pct 10]
#
#   --db NAME            migration dry-run: `pg_dump --schema-only NAME` into a scratch database, then the release's migrate()
#                        TWICE on it (the second run proves it is idempotent). NAME itself is only read.
#   --env-from-pm2 NAME  check the environment of the RUNNING PM2 process (variable names via `pm2 jlist`) instead of this shell's
# Exit code: 0 = no FAIL (warnings allowed), 1 = at least one FAIL, 2 = bad usage.
set -u
cd "$(dirname "$0")/.." || exit 2
DB=""; PM2=""; MAX_BACKUP_H=36; MIN_FREE=10
while [ $# -gt 0 ]; do case "$1" in
  --db) DB="${2:-}"; shift 2 ;;
  --env-from-pm2) PM2="${2:-}"; shift 2 ;;
  --max-backup-hours) MAX_BACKUP_H="${2:-}"; shift 2 ;;
  --min-free-pct) MIN_FREE="${2:-}"; shift 2 ;;
  -h|--help) sed -n 2,13p "$0"; exit 0 ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
esac; done
if [ -n "$DB" ] && ! [[ "$DB" =~ ^[a-z0-9_]+$ ]]; then echo "--db takes a plain database name" >&2; exit 2; fi
FAILS=0; WARNS=0
ok()   { echo "ok    $1"; }
warn() { echo "WARN  $1"; WARNS=$((WARNS + 1)); }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

echo "== build"
if git rev-parse --short HEAD >/dev/null 2>&1; then
  HEAD_SHA=$(git rev-parse --short HEAD); ok "checkout at $HEAD_SHA"
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then warn "the checkout has uncommitted changes: what runs will not be exactly $HEAD_SHA"; fi
else warn "not a git checkout: the commit cannot be checked"; HEAD_SHA=""; fi
for f in dist/api.mjs dist/signer.mjs dist/web/index.html; do
  if [ -s "$f" ]; then ok "$f present"; else fail "$f is missing: run pnpm build"; fi
done
if [ -s dist/api.mjs ]; then
  NEWEST_SRC=$(find services/api/src packages/core/src packages/swap/src packages/derivatives/src -name '*.ts' -newer dist/api.mjs 2>/dev/null | head -1)
  if [ -n "$NEWEST_SRC" ]; then fail "dist/api.mjs is older than the sources (e.g. $NEWEST_SRC): rebuild"; else ok "dist/api.mjs is newer than the API sources"; fi
  if [ -n "$HEAD_SHA" ]; then if grep -q "\"$HEAD_SHA\"" dist/api.mjs; then ok "dist/api.mjs was built from $HEAD_SHA"; else warn "dist/api.mjs does not carry commit $HEAD_SHA (built from another commit, or SPW_COMMIT was set)"; fi; fi
fi
if [ -x node_modules/.bin/tsc ]; then
  if pnpm -s typecheck >/tmp/spw-preflight-tsc.$$ 2>&1; then ok "typecheck clean"; else fail "typecheck fails ($(grep -c 'error TS' /tmp/spw-preflight-tsc.$$) errors; pnpm typecheck)"; fi
  rm -f /tmp/spw-preflight-tsc.$$
else warn "node_modules is missing: typecheck skipped (pnpm install --frozen-lockfile)"; fi
if [ -x research/.venv/bin/python ]; then ok "research/.venv present (the strategy sandbox needs it)"; else fail "research/.venv is missing: the strategy sandbox will be unavailable and agents will hold (cd research && uv sync --frozen)"; fi
if [ -x /usr/bin/sandbox-exec ]; then ok "sandbox-exec present"; else fail "/usr/bin/sandbox-exec is missing: strategy code will not run on this machine"; fi

echo "== environment (names only)"
NAMES=""
if [ -n "$PM2" ]; then
  if command -v pm2 >/dev/null 2>&1; then
    NAMES=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{const p=JSON.parse(s).find((x)=>x.name===process.argv[1]);if(!p){process.exit(3)}const e=p.pm2_env||{};const all={...e,...(e.env||{})};console.log(Object.keys(all).filter((k)=>typeof all[k]==="string"&&all[k]!=="").join("\n"))}catch{process.exit(4)}})' "$PM2")
    case $? in 0) ok "environment read from the PM2 process $PM2" ;; 3) fail "no PM2 process named $PM2" ;; *) fail "could not read pm2 jlist" ;; esac
  else fail "pm2 is not on PATH"; fi
else
  NAMES=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=..*/\1/p'); ok "environment read from this shell (use --env-from-pm2 <name> for the running process)"
fi
has() { printf '%s\n' "$NAMES" | grep -qx "$1"; }
for v in SPW_ORIGIN SPW_RP_ID DATABASE_URL SPW_SIGNER_SECRET; do if has "$v"; then ok "$v is set"; else fail "$v is not set (required: the API does not start)"; fi; done
for v in SPW_DERIV_LIVE_MAINNET RESEARCH_DATABASE_URL SPW_RESEARCH_RUNNER_SECRET; do
  if has "$v"; then ok "$v is set"; else warn "$v is not set (optional — see the table in docs/runbooks/deploy.md; the API will log it as OFF)"; fi
done
if has SPW_LAB_SANDBOX && [ -z "$PM2" ] && [ "${SPW_LAB_SANDBOX:-}" = off ]; then fail "SPW_LAB_SANDBOX=off: strategy code would run without OS confinement"; fi
if has SPW_BROADCAST && [ -z "$PM2" ] && [ "${SPW_BROADCAST:-}" = off ]; then warn "SPW_BROADCAST=off: nothing would be relayed (test mode)"; fi

echo "== signer"
SIGNER_URL="${SPW_SIGNER_URL:-http://127.0.0.1:8651}"
HOSTPORT=$(printf '%s' "$SIGNER_URL" | sed -E 's#^[a-z]+://##; s#/.*$##'); SH=${HOSTPORT%%:*}; SP=${HOSTPORT##*:}
if [[ "$SP" =~ ^[0-9]+$ ]] && (exec 3<>"/dev/tcp/$SH/$SP") 2>/dev/null; then ok "the signer's port answers ($SH:$SP; a TCP connection only — nothing was sent)"
else fail "nothing listens at the signer address $SH:$SP (SPW_SIGNER_URL; on the API node this is the relay, see operations.md)"; fi

echo "== disk and backup"
FREE=$(df -Pk "$HOME" | awk 'NR==2 { printf "%d", 100 - $5 }')
if [ "${FREE:-0}" -ge "$MIN_FREE" ]; then ok "disk: $FREE % free on the volume of \$HOME"; else fail "disk: only ${FREE:-?} % free (threshold $MIN_FREE %)"; fi
BDIR="${SPW_BACKUP_DIR:-$HOME/backups/sp-wallet}"
LAST=$(ls -1t "$BDIR"/sp-wallet-*.sql.gz 2>/dev/null | head -1)
if [ -z "$LAST" ]; then warn "no backup found in the backup directory (scripts/backup.sh before a migration)"
else
  AGE_H=$(( ($(date +%s) - $(mtime "$LAST")) / 3600 )); SIZE=$(wc -c < "$LAST" | tr -d ' ')
  if [ "$SIZE" -lt 1000 ]; then fail "the newest backup ($(basename "$LAST")) is $SIZE bytes: it is empty"
  elif [ "$AGE_H" -gt "$MAX_BACKUP_H" ]; then warn "the newest backup ($(basename "$LAST")) is $AGE_H h old (threshold $MAX_BACKUP_H h): take one before a migration"
  else ok "newest backup: $(basename "$LAST"), $AGE_H h old, $SIZE bytes"; fi
fi

if [ -n "$DB" ]; then
  echo "== migration dry-run on a copy of the schema of $DB"
  SCRATCH="spw_preflight_$(date +%s)_$$"
  if ! psql -At -d postgres -c "select 1 from pg_database where datname = '$DB'" 2>/dev/null | grep -q 1; then fail "database $DB does not exist on the local PostgreSQL"
  elif ! createdb "$SCRATCH" 2>/dev/null; then fail "could not create the scratch database"
  else
    trap 'dropdb --if-exists "$SCRATCH" >/dev/null 2>&1' EXIT
    if pg_dump --schema-only --no-owner --no-privileges "$DB" 2>/tmp/spw-preflight-dump.$$ | psql -q -v ON_ERROR_STOP=1 -d "$SCRATCH" >/dev/null 2>>/tmp/spw-preflight-dump.$$; then
      ok "schema of $DB copied to a scratch database ($(psql -At -d "$SCRATCH" -c "select count(*) from information_schema.tables where table_schema = 'public'") tables, no rows)"
      OUT=$(SPW_ORIGIN=https://preflight.invalid SPW_RP_ID=preflight.invalid DATABASE_URL="postgres:///$SCRATCH" SPW_SIGNER_SECRET=preflight-not-a-secret SPW_WORKERS=off SPW_BROADCAST=off \
        node_modules/.bin/tsx scripts/lib/preflight-migrate.mts 2>&1); RC=$?
      if [ $RC -eq 0 ]; then ok "migrate() twice on the copy: $OUT"; else fail "migrate() fails on a copy of the schema of $DB: $(printf '%s' "$OUT" | tail -1 | cut -c1-200)"; fi
    else fail "could not copy the schema of $DB ($(tail -1 /tmp/spw-preflight-dump.$$ | cut -c1-160))"; fi
    rm -f /tmp/spw-preflight-dump.$$
    dropdb --if-exists "$SCRATCH" >/dev/null 2>&1; trap - EXIT
    ok "scratch database dropped"
  fi
fi

echo "== $FAILS FAIL, $WARNS WARN"
[ "$FAILS" -eq 0 ]
