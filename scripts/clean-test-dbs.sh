#!/bin/bash
# Drop the test databases left behind by a killed or crashed test run.
#
# Every vitest run names its databases spw_t_<start, seconds, base 36>_<checkout hash><random>_<label> and drops them when it
# ends (services/api/test/test-db.ts, global-db.ts). A run that was killed (kill -9, a closed terminal, a power cut) leaves its
# databases behind; this script removes them.
#
#   scripts/clean-test-dbs.sh            drop spw_t_* databases whose run started more than 2 hours ago
#   scripts/clean-test-dbs.sh --hours 0  drop them all (only when no test run is in progress on this machine)
#   scripts/clean-test-dbs.sh --dry-run  list what would be dropped
#   scripts/clean-test-dbs.sh --legacy   also drop the fixed-name test databases used before v8 (spw_test, spw_market_test, …)
# Uses the local PostgreSQL (psql on PATH, database "postgres"). Never touches a database whose name does not match.
set -eu
HOURS=2; DRY=0; LEGACY=0
while [ $# -gt 0 ]; do case "$1" in
  --hours) HOURS="$2"; shift 2 ;;
  --dry-run) DRY=1; shift ;;
  --legacy) LEGACY=1; shift ;;
  *) echo "usage: $0 [--hours N] [--dry-run] [--legacy]" >&2; exit 2 ;;
esac; done
case "$HOURS" in ''|*[!0-9]*) echo "--hours takes a whole number" >&2; exit 2 ;; esac
NOW=$(date +%s); CUT=$((NOW - HOURS * 3600)); N=0
drop() {
  if [ "$DRY" = 1 ]; then echo "would drop $1"; else psql -q -d postgres -c "drop database if exists \"$1\" with (force)" >/dev/null && echo "dropped $1"; fi
  N=$((N + 1))
}
for db in $(psql -At -d postgres -c "select datname from pg_database where datname like 'spw\_t\_%' order by 1"); do
  [[ "$db" =~ ^spw_t_([0-9a-z]+)_[0-9a-f]{8}_[a-z0-9_]+$ ]] || continue
  start=$((36#${BASH_REMATCH[1]}))
  if [ "$start" -le "$CUT" ]; then drop "$db"; fi
done
if [ "$LEGACY" = 1 ]; then
  for db in spw_test spw_market_test spw_test_cctp spw_test_jupiter spw_test_plan spw_test_xswap spw_v5_agents_test spw_v6_alerts_api_test spw_v6_alerts_engine_test spw_v7_research_test \
            spw_deriv_test spw_deriv_paper_test spw_deriv_live_test spw_deriv_router_test spw_deriv_collateral_test spw_deriv_mandate_test spw_perp_agent_test spw_perp_live_test; do
    if [ "$(psql -At -d postgres -c "select 1 from pg_database where datname = '$db'")" = 1 ]; then drop "$db"; fi
  done
fi
if [ "$DRY" = 1 ]; then echo "$N database(s) would be dropped"; else echo "$N database(s) dropped"; fi
