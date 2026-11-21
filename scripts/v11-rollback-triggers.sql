-- =============================================================================
-- SP BOUCHER | SOURCE FILE
-- =============================================================================
-- Project      : SP Wallet
-- File         : scripts/v11-rollback-triggers.sql
-- Author       : Simon-Pierre Boucher | https://spboucher.ai
-- Contact      : support@spboucher.ai
-- Copyright    : (c) 2026 Simon-Pierre Boucher
-- License      : None specified (no license file in this repository)
-- =============================================================================
-- END OF SP BOUCHER SOURCE HEADER
-- =============================================================================

-- V11 → V10 code rollback: the database triggers V11 leaves behind (docs/V11-DEPLOYMENT.md §9; rehearsed 2026-11-17 on a local
-- database, docs/v11/work/final-validation.md). Run it ONLY when the API is going back to a build older than V11, AFTER that
-- decision, on the API node:
--
--   psql -v ON_ERROR_STOP=1 -d sp_wallet -f scripts/v11-rollback-triggers.sql              the gate only (what a rollback needs)
--   psql -v ON_ERROR_STOP=1 -v queue=1 -d sp_wallet -f scripts/v11-rollback-triggers.sql   + the four queue triggers
--   psql -v ON_ERROR_STOP=1 -v park_agents=1 -d sp_wallet -f scripts/v11-rollback-triggers.sql     + V11-only agents made listable by V10
--   psql -v ON_ERROR_STOP=1 -v unpark_agents=1 -d sp_wallet -f scripts/v11-rollback-triggers.sql   BEFORE going forward again: undo park_agents (touches nothing else)
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
--   -v park_agents=1   V11-ONLY AGENTS. A stream agent (market making, cross-exchange, funding arbitrage) or the risk supervisor is a
--   row of `agents` whose `network` is a venue name. V10 reads every row of that table as a spot or a perp agent: with ONE such
--   row, `GET /api/v1/agents` answers 500 « unknown network: hyperliquid » under V10 and the Agents screen shows nothing at all
--   (observed, whatever the state of the agent — stopping it in V11 does not help). V10's engines are not affected: they select
--   `kind = 'spot'` / `kind = 'perp'` and never tick these rows. With park_agents the network of those rows is set to `base` (the
--   original is kept in `runtime.v11RollbackNetwork`): V10 then lists them — as agents it does not understand: DO NOT act on them
--   there. STOP them in V11 first when V11 still starts.
--   -v unpark_agents=1 puts the networks back: RUN IT BEFORE V11 IS STARTED AGAIN, or the stream agents would name the wrong venue.
--
-- GOING FORWARD AGAIN needs nothing for the triggers: migrate() of V11 re-creates every one at start-up (`drop trigger if exists` +
-- `create`). It needs `-v unpark_agents=1` first if park_agents was used.
begin;
\if :{?unpark_agents}
update agents set network = runtime->>'v11RollbackNetwork', runtime = runtime - 'v11RollbackNetwork' where runtime ? 'v11RollbackNetwork';
\else
drop trigger if exists agent_orders_gate on agent_orders;
\endif
\if :{?park_agents}
update agents set runtime = coalesce(runtime, '{}'::jsonb) || jsonb_build_object('v11RollbackNetwork', network), network = 'base'
  where kind not in ('spot', 'perp') and not (coalesce(runtime, '{}'::jsonb) ? 'v11RollbackNetwork');
\endif
\if :{?queue}
drop trigger if exists deriv_orders_projection on deriv_orders;
drop trigger if exists deriv_gmx_ops_projection on deriv_gmx_ops;
drop trigger if exists proposals_swap_projection on proposals;
drop trigger if exists agent_orders_projection on agent_orders;
\endif
commit;
select tgname as trigger_left, tgrelid::regclass as on_table from pg_trigger where not tgisinternal order by 1;
select name as v11_only_agent, kind, state, network, runtime->>'v11RollbackNetwork' as parked_from from agents where kind not in ('spot', 'perp') order by created_at;
select coalesce((value->'killSwitch'->>'on')::boolean, false) as kill_switch_still_recorded_on, coalesce((value->'readOnly'->>'on')::boolean, false) as read_only_still_recorded_on from settings where key = 'risk.switches';
