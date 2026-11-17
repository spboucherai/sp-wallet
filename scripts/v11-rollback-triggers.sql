-- V11 → V10 code rollback: the database triggers V11 leaves behind (docs/V11-DEPLOYMENT.md §9; rehearsed 2026-11-17 on a local
-- database, docs/v11/work/final-validation.md). Run it ONLY when the API is going back to a build older than V11, AFTER that
-- decision, on the API node:
--
--   psql -v ON_ERROR_STOP=1 -d sp_wallet -f scripts/v11-rollback-triggers.sql              the gate only (what a rollback needs)
--   psql -v ON_ERROR_STOP=1 -v queue=1 -d sp_wallet -f scripts/v11-rollback-triggers.sql   + the four queue triggers
--
-- WHAT IT DOES
--   agent_orders_gate (always dropped). It refuses a spot agent's order row while the V11 kill switch or read-only mode is on
--   (settings 'risk.switches'). V10 code has no screen and no route to release either: with a switch left on, every BUY of a
--   spot agent raises `kill_switch_active` at the insert, under V10, for ever (observed). Releasing both switches in V11 BEFORE
--   the rollback makes this script unnecessary; this is for the case where V11 can no longer be started to do it.
--   Dropping the gate does not release the switch: the settings row is left as it is, and V11 applies it again at its next start.
--
--   The four queue triggers (dropped only with -v queue=1). Under V10 every write to deriv_orders, deriv_gmx_ops, proposals
--   (swaps) and agent_orders still inserts a row into order_projection_queue, which V10 never drains: about two small rows per
--   order. KEEP THEM for a short rollback: at the next V11 start the queue is drained and the orders made under V10 become
--   unified orders (observed: caught up within seconds, nothing duplicated). Drop them only for a long stay on V10 — the orders
--   made meanwhile will then NEVER appear in the unified `orders` table, as is already the case for orders older than V11.
--
-- WHAT IT LEAVES ALONE
--   order_events_append_only (V10 never writes that table), research_log_defaults (it only fills a missing mode; V10's inserts
--   pass through it, observed), audit_no_update (older than V11), every table, column and row.
--
-- GOING FORWARD AGAIN needs nothing: migrate() of V11 re-creates every trigger at start-up (`drop trigger if exists` + `create`).
begin;
drop trigger if exists agent_orders_gate on agent_orders;
\if :{?queue}
drop trigger if exists deriv_orders_projection on deriv_orders;
drop trigger if exists deriv_gmx_ops_projection on deriv_gmx_ops;
drop trigger if exists proposals_swap_projection on proposals;
drop trigger if exists agent_orders_projection on agent_orders;
\endif
commit;
select tgname as trigger_left, tgrelid::regclass as on_table from pg_trigger where not tgisinternal order by 1;
select coalesce((value->'killSwitch'->>'on')::boolean, false) as kill_switch_still_recorded_on, coalesce((value->'readOnly'->>'on')::boolean, false) as read_only_still_recorded_on from settings where key = 'risk.switches';
