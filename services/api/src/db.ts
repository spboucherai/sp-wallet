import postgres from 'postgres';
import { appendAudit, verifyAuditChain, type AuditRecord } from '@spw/core';
import { config } from './config.ts';

export const sql = postgres(config.databaseUrl, { max: 8, idle_timeout: 30, onnotice: () => {} });

const SCHEMA = `
create table if not exists credentials (
  id text primary key, public_key text not null, counter bigint not null default 0, transports jsonb not null default '[]',
  label text not null default '', device_type text not null default '', backed_up boolean not null default false,
  created_at timestamptz not null default now(), last_used_at timestamptz);
create table if not exists pending_credentials (
  id text primary key, public_key text not null, counter bigint not null, transports jsonb not null, label text not null,
  device_type text not null, backed_up boolean not null, expires_at timestamptz not null);
create table if not exists sessions (
  id_hash text primary key, created_at timestamptz not null default now(), last_seen timestamptz not null default now(),
  expires_at timestamptz not null, ua text not null default '', ip text not null default '', revoked boolean not null default false);
create table if not exists challenges (
  id uuid primary key, kind text not null, challenge text not null, expires_at timestamptz not null);
create table if not exists proposals (
  id uuid primary key, idempotency_key text unique not null, state text not null, version int not null default 0,
  network text not null, asset text not null, symbol text not null, decimals int not null, amount numeric(78,0) not null check (amount > 0),
  from_addr text not null, to_addr text not null, note text not null default '',
  fee_estimate numeric(78,0), max_fee numeric(78,0), warnings jsonb not null default '[]',
  intent jsonb, intent_hash text, raw text, txid text, block_ref text, confirmations int not null default 0, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz, broadcast_at timestamptz, last_broadcast_at timestamptz, finalized_at timestamptz);
alter table proposals add column if not exists memo text;
alter table proposals add column if not exists aux jsonb;
alter table proposals add column if not exists kind text not null default 'transfer';
alter table proposals add column if not exists swap jsonb;
alter table proposals add column if not exists pre_raw text;
alter table proposals add column if not exists pre_txid text;
alter table proposals add column if not exists pre_state text;
alter table proposals add column if not exists out_amount numeric(78,0);
alter table proposals add column if not exists bridge jsonb;
alter table proposals add column if not exists xswap jsonb;
-- >>> v11 stabilisation: why a proposal ended as a code + parameters (the UI translates them; the error column stays the English sentence),
-- the request fingerprint behind an idempotency key (same key + same body = same proposal; another body = 409), and the
-- quote the owner was looking at when he asked for the preparation (B6)
alter table proposals add column if not exists error_code text;
alter table proposals add column if not exists error_params jsonb;
alter table proposals add column if not exists request_hash text;
alter table proposals add column if not exists quote_ref jsonb;
-- rows left in 'broadcast' by a server that does not broadcast (B2) become what they are: signed, never sent
update proposals set state = 'not_broadcast', error_code = 'broadcast_disabled', broadcast_at = null, last_broadcast_at = null
  where state = 'broadcast' and error like 'broadcast disabled%';
-- <<< v11 stabilisation
create unique index if not exists proposals_txid on proposals (network, txid) where txid is not null;
create table if not exists deposits (
  network text not null, txid text not null, idx int not null, asset text not null, amount numeric(78,0) not null,
  from_addr text not null default '', block bigint not null, block_time timestamptz, seen_at timestamptz not null default now(),
  primary key (network, txid, idx, asset));
create table if not exists scan_cursor (network text primary key, cursor bigint not null, finalized bigint not null default 0);
create table if not exists address_book (
  id uuid primary key, network text not null, address text not null, label text not null, created_at timestamptz not null default now(),
  unique (network, address));
create table if not exists swap_quotes (
  id bigserial primary key, at timestamptz not null default now(), search_id uuid not null, provider text not null,
  from_key text not null, to_key text not null, amount_in numeric(78,0) not null, amount_out numeric(78,0), min_out numeric(78,0),
  ms int not null, ok boolean not null, code text);
create index if not exists swap_quotes_at on swap_quotes (at);
create table if not exists agents (
  id uuid primary key, name text not null, mission text not null default '', state text not null default 'CREATED', mode text not null default 'RESEARCH',
  network text not null default 'base', universe jsonb not null, interval text not null default '1h', risk jsonb not null,
  vault_index int unique not null, vault_address text not null, capital_usdc numeric(78,0) not null default 0,
  strategy_version_id uuid, mandate_id uuid, mandate jsonb, last_bar timestamptz, stop_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
-- V5: agents on every execution-enabled network; cash leg and the registry asset chosen for each market symbol
alter table agents add column if not exists cash text not null default 'USDC';
alter table agents add column if not exists assets jsonb not null default '{}';
create table if not exists strategy_versions (
  id uuid primary key, agent_id uuid not null references agents(id), name text not null, version text not null, code_sha256 text not null, path text not null,
  meta jsonb not null default '{}', status text not null default 'draft', report jsonb, notes text not null default '',
  created_at timestamptz not null default now(), approved_at timestamptz, unique (agent_id, code_sha256));
create table if not exists agent_orders (
  id uuid primary key, agent_id uuid not null references agents(id), ts timestamptz not null default now(), mode text not null,
  from_asset text not null, to_asset text not null, from_symbol text not null, to_symbol text not null,
  amount_in numeric(78,0) not null, expected_out numeric(78,0), min_out numeric(78,0), received numeric(78,0),
  state text not null, reason text, txid text, pre_txid text, raw text, pre_raw text, intent jsonb, aux jsonb, bar timestamptz, updated_at timestamptz not null default now());
create index if not exists agent_orders_agent on agent_orders (agent_id, ts desc);
create table if not exists agent_equity (
  agent_id uuid not null references agents(id), ts timestamptz not null, mode text not null, equity_usd double precision not null, positions jsonb not null, primary key (agent_id, ts, mode));
create table if not exists agent_paper (agent_id uuid not null references agents(id), symbol text not null, units double precision not null, primary key (agent_id, symbol));
create table if not exists research_log (
  id bigserial primary key, agent_id uuid references agents(id), ts timestamptz not null default now(), kind text not null, title text not null, body text not null default '', data jsonb);
create table if not exists settings (key text primary key, value jsonb not null);
create table if not exists candles (
  source text not null, symbol text not null, interval text not null, ts timestamptz not null,
  open double precision not null, high double precision not null, low double precision not null, close double precision not null,
  volume double precision not null, primary key (source, symbol, interval, ts));
create index if not exists candles_series on candles (symbol, interval, ts);
create table if not exists market_quality (
  symbol text not null, interval text not null, checked_at timestamptz not null, last_ts timestamptz, fresh boolean not null,
  gaps int not null, max_deviation_bps double precision, status text not null, detail jsonb not null default '{}',
  primary key (symbol, interval));
create table if not exists audit_events (
  seq bigint primary key, ts text not null, type text not null, actor text not null, data jsonb not null, prev text not null, hash text not null);
create or replace function spw_audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
drop trigger if exists audit_no_update on audit_events;
create trigger audit_no_update before update or delete or truncate on audit_events for each statement execute function spw_audit_immutable();
-- derivatives, wave 2 (read-only and paper). Every price, size and amount is numeric (exact) or a decimal string inside jsonb.
create table if not exists deriv_paper_accounts (
  id uuid primary key, venue text not null, network text not null, label text not null, initial_collateral numeric not null,
  state jsonb not null, policy jsonb not null, meta jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists deriv_orders (
  account_id uuid not null references deriv_paper_accounts(id) on delete cascade, client_id text not null, venue_order_id text,
  instrument text not null, side text not null, type text not null, size numeric not null, price numeric, trigger_price numeric,
  reduce_only boolean not null, tif text not null, status text not null, filled numeric not null default 0, avg_fill_price numeric,
  reject_reason text, origin text not null default 'owner', first_result jsonb,
  created_at timestamptz not null, updated_at timestamptz not null, primary key (account_id, client_id));
create index if not exists deriv_orders_recent on deriv_orders (account_id, created_at desc);
create table if not exists deriv_fills (
  account_id uuid not null references deriv_paper_accounts(id) on delete cascade, fill_id text not null, instrument text not null,
  order_id text, client_id text, side text not null, price numeric not null, size numeric not null, fee numeric not null, fee_asset text not null,
  closed_pnl numeric, liquidation boolean not null default false, ts timestamptz not null, primary key (account_id, fill_id));
create index if not exists deriv_fills_recent on deriv_fills (account_id, ts desc);
create table if not exists deriv_funding (
  account_id uuid not null references deriv_paper_accounts(id) on delete cascade, instrument text not null, ts timestamptz not null,
  amount numeric not null, rate numeric not null, size numeric not null, primary key (account_id, instrument, ts));
create table if not exists deriv_risk_events (
  id bigserial primary key, account_id uuid not null references deriv_paper_accounts(id) on delete cascade, ts timestamptz not null,
  kind text not null, code text, message text not null, data jsonb not null default '{}', dedupe text, unique (account_id, dedupe));
create index if not exists deriv_risk_events_recent on deriv_risk_events (account_id, ts desc);
create table if not exists deriv_equity (
  account_id uuid not null references deriv_paper_accounts(id) on delete cascade, ts timestamptz not null,
  equity numeric not null, collateral numeric not null, margin_used numeric not null, unrealized_pnl numeric not null, primary key (account_id, ts));
-- derivatives, controlled live (venue accounts). A venue account starts READ_ONLY; only the owner's passkey (through the signer) changes that.
create table if not exists deriv_accounts (
  id uuid primary key, venue text not null, network text not null, account text not null, agent_address text not null, agent_name text not null default '',
  label text not null default '', mode text not null default 'READ_ONLY', policy jsonb not null, pending jsonb,
  authorization_id uuid, authorization_hash text, venue_authorization jsonb, halt text, divergence text, meta jsonb not null default '{}',
  last_nonce bigint not null default 0, authorized_at timestamptz, revoked_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (venue, network, account));
-- orders, fills, funding, risk events and equity of venue accounts live in the same tables as the paper ones, keyed by the account
-- id (a uuid of either table): the foreign keys to deriv_paper_accounts are dropped, nothing else changes for paper accounts.
alter table deriv_orders drop constraint if exists deriv_orders_account_id_fkey;
alter table deriv_fills drop constraint if exists deriv_fills_account_id_fkey;
alter table deriv_funding drop constraint if exists deriv_funding_account_id_fkey;
alter table deriv_risk_events drop constraint if exists deriv_risk_events_account_id_fkey;
alter table deriv_equity drop constraint if exists deriv_equity_account_id_fkey;
-- live order state machine: proposed → risk_checked → authorized → signed → submitted → open|filled|partially_filled|cancelled|rejected, plus unknown
alter table deriv_orders add column if not exists state text;
alter table deriv_orders add column if not exists final boolean not null default false;
alter table deriv_orders add column if not exists cloid text;
alter table deriv_orders add column if not exists request jsonb;
alter table deriv_orders add column if not exists order_hash text;
alter table deriv_orders add column if not exists nonce bigint;
alter table deriv_orders add column if not exists expires_at timestamptz;
-- json, not jsonb: the venue hashes an action with its keys in order, and jsonb does not keep the order of keys
alter table deriv_orders add column if not exists action json;
alter table deriv_orders add column if not exists sign_request json;
alter table deriv_orders add column if not exists signature jsonb;
alter table deriv_orders add column if not exists venue_answer jsonb;
alter table deriv_orders add column if not exists submitted_at timestamptz;
create index if not exists deriv_orders_live on deriv_orders (account_id) where state is not null and not final;
-- leverage changes and cancels sent to a venue (one row per signed action)
create table if not exists deriv_actions (
  id uuid primary key, account_id uuid not null, kind text not null, state text not null, request jsonb not null, action_hash text,
  nonce bigint not null, expires_at timestamptz not null, action json not null, sign_request json not null, signature jsonb, venue_answer jsonb,
  error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists deriv_actions_recent on deriv_actions (account_id, created_at desc);
-- >>> v6 perp agents (paper only): additive. An agent of kind 'perp' owns one derivatives paper account; it has no vault (a
-- negative vault_index keeps the unique column, the signer is never asked for an address) and no mandate.
alter table agents add column if not exists kind text not null default 'spot';
alter table agents add column if not exists deriv_account_id uuid;
alter table agents add column if not exists perp jsonb not null default '{}';
-- the venue's own closed bars and hourly funding settlements (exact decimals), so that a signal does not refetch its lookback
create table if not exists perp_candles (
  venue text not null, symbol text not null, interval text not null, ts timestamptz not null,
  open numeric not null, high numeric not null, low numeric not null, close numeric not null, volume numeric not null,
  primary key (venue, symbol, interval, ts));
create table if not exists perp_funding (
  venue text not null, symbol text not null, ts timestamptz not null, time_ms bigint not null, rate numeric not null, premium numeric,
  primary key (venue, symbol, ts));
-- one decision per agent and closed bar (the signal log): the row exists before any order of that bar is sent
create table if not exists perp_agent_signals (
  agent_id uuid not null references agents(id), bar timestamptz not null, status text not null, reason text not null default '',
  strategy_sha256 text not null, weights jsonb, scaled jsonb, scale text, equity numeric, targets jsonb, orders jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key (agent_id, bar));
-- <<< v6 perp agents
-- >>> v7 perp agents LIVE: the venue account an agent trades under a derivative mandate; one agent per venue account
alter table agents add column if not exists live_account_id uuid;
create unique index if not exists agents_live_account on agents (live_account_id) where live_account_id is not null;
-- <<< v7 perp agents LIVE
-- derivative mandates (MANDATE_LIVE): the canonical mandate the owner approved with his passkey; the signer holds its own copy and enforces it
create table if not exists deriv_mandates (
  id uuid primary key, account_id uuid not null, authorization_id uuid not null, state text not null, mandate jsonb not null, hash text not null, ack jsonb not null,
  prepared_at timestamptz not null, approved_at timestamptz, revoked_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists deriv_mandates_account on deriv_mandates (account_id, approved_at desc);
-- an order placed under a mandate names it and the agent that asked for it; every proposal keeps the estimate it was shown with
alter table deriv_orders add column if not exists mandate_id uuid;
alter table deriv_orders add column if not exists agent jsonb;
alter table deriv_orders add column if not exists estimate jsonb;
-- collateral of venue accounts (v6): deposits (a wallet proposal + the credit read from the venue's ledger) and withdrawals (withdraw3 + arrival on the wallet)
create table if not exists deriv_collateral (
  id uuid primary key, account_id uuid not null, kind text not null, state text not null, final boolean not null default false, venue_network text not null,
  amount numeric not null check (amount > 0), fee numeric, chain_network text, proposal_id uuid, txid text, op_hash text, request jsonb not null default '{}',
  action json, signature jsonb, venue_answer jsonb, nonce bigint, balance_before jsonb, balance_after jsonb, ledger jsonb, arrival jsonb, error text, attempts int not null default 0,
  expires_at timestamptz, sent_at timestamptz, venue_at timestamptz, done_at timestamptz, checked_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists deriv_collateral_open on deriv_collateral (account_id) where not final;
create index if not exists deriv_collateral_recent on deriv_collateral (account_id, created_at desc);
-- >>> v8 GMX v2 trading: one row per order action of the wallet on GMX (increase, decrease, cancel). The on-chain transaction is an ordinary proposal (kind 'gmx'); this row follows the ORDER by its key
create table if not exists deriv_gmx_ops (
  id uuid primary key, idempotency_key text unique, kind text not null, state text not null, final boolean not null default false, account text not null,
  market text, is_long boolean, collateral_token text, amount text, size_usd text, acceptable_price text, slippage_bps int, execution_fee text not null default '0', max_fee text not null default '0',
  needs_approval boolean not null default false, order_key text, target_op uuid, proposal_id uuid, op_hash text, txid text, pre_txid text, block_number bigint,
  request jsonb not null default '{}', estimate jsonb, outcome jsonb, error text, attempts int not null default 0,
  expires_at timestamptz, sent_at timestamptz, order_created_at timestamptz, done_at timestamptz, checked_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists deriv_gmx_ops_open on deriv_gmx_ops (created_at) where not final;
create index if not exists deriv_gmx_ops_recent on deriv_gmx_ops (created_at desc);
-- <<< v8 GMX v2 trading
-- >>> v7 any-to-any plans: a plan is a list of legs; each leg is an ordinary proposal created when the previous one has settled
create table if not exists plans (
  id uuid primary key, state text not null, current int not null default 0, legs jsonb not null, meta jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists plans_open on plans (state) where state in ('active', 'paused');
-- <<< v7 any-to-any plans
-- v8 hardening: tracked agent-vault withdrawals (agents/withdrawals.ts)
create table if not exists agent_withdrawals (
  id uuid primary key, agent_id uuid not null references agents(id), network text not null, asset text not null, symbol text not null, decimals int not null,
  amount numeric(78,0) not null, from_addr text not null, to_addr text not null, nonce int not null, state text not null, raw text, txid text, error text,
  idempotency_key text, arrival jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  broadcast_at timestamptz, last_broadcast_at timestamptz, confirmed_at timestamptz);
create unique index if not exists agent_withdrawals_one_open on agent_withdrawals (agent_id, network, asset) where state in ('requested', 'signed', 'broadcast');
create unique index if not exists agent_withdrawals_idem on agent_withdrawals (agent_id, idempotency_key) where idempotency_key is not null;
create index if not exists agent_withdrawals_agent on agent_withdrawals (agent_id, created_at desc);
-- >>> v11 trading API (services/api/src/trading-api): machine authentication. A key row never holds the secret: secret_hash is
-- HMAC-SHA-256 under a pepper that lives outside the database. Scopes are a closed list (spec.ts); limits are recorded now and
-- enforced when execution lands; mandate_id binds the key to a signer-enforced trading mandate (execution scopes are inert without one).
create table if not exists api_keys (
  id text primary key, name text not null, secret_hash text not null, scopes text[] not null, limits jsonb not null default '{}', restrictions jsonb not null default '{}',
  rate_limit_per_min int not null default 120, mandate_id uuid, rotated_from text, created_at timestamptz not null default now(), expires_at timestamptz not null,
  revoked_at timestamptz, revoked_reason text, last_used_at timestamptz, last_used_ip text);
-- one row per call made with a key (and per refused call that named a real key): no body, no header, no secret
create table if not exists api_key_usage (
  id bigserial primary key, key_id text not null, ts timestamptz not null default now(), method text not null, route text not null,
  status int not null, latency_ms int not null, request_id text not null, ip text not null default '');
create index if not exists api_key_usage_key on api_key_usage (key_id, ts desc);
create index if not exists api_key_usage_ts on api_key_usage (ts);
-- a key-management request waiting for the owner's passkey: the WebAuthn challenge is the SHA-256 of canonical; single use
create table if not exists api_key_intents (
  id uuid primary key, action text not null, canonical text not null, hash text not null, created_at timestamptz not null default now(), expires_at timestamptz not null);
-- replay protection of mutating calls: the first answer of (principal, Idempotency-Key) is stored with the hash of the request
create table if not exists api_idempotency (
  principal text not null, key text not null, request_hash text not null, state text not null default 'in_progress', status int, response jsonb,
  created_at timestamptz not null default now(), primary key (principal, key));
create index if not exists api_idempotency_at on api_idempotency (created_at);
-- outgoing webhooks of API clients (the signing secret of an endpoint is NOT here: it is in the secrets file of the API user)
create table if not exists api_webhooks (
  id text primary key, url text not null, events text[] not null, enabled boolean not null default true, label text not null default '',
  created_at timestamptz not null default now(), last_ok_at timestamptz, last_error text, failures int not null default 0);
create table if not exists api_webhook_deliveries (
  id bigserial primary key, webhook_id text not null references api_webhooks(id) on delete cascade, event_id uuid not null, event text not null, payload jsonb not null,
  state text not null default 'pending', attempts int not null default 0, next_attempt_at timestamptz not null default now(), last_status int, last_error text,
  created_at timestamptz not null default now(), delivered_at timestamptz);
create index if not exists api_webhook_deliveries_due on api_webhook_deliveries (next_attempt_at) where state = 'pending';
create index if not exists api_webhook_deliveries_recent on api_webhook_deliveries (webhook_id, id desc);
-- <<< v11 trading API
-- >>> v11 execution (services/api/src/orders, risk, mandates): ONE order table for every principal, mode and venue. A row is
-- changed only by transition() of @spw/trading (orders/store.ts); order_events is its append-only history. The venue engines
-- keep their own rows (deriv_orders, deriv_gmx_ops): a trigger queues every change of them, and the projector (orders/projection.ts)
-- turns each change into events of the unified order — whatever code path wrote the engine row.
create table if not exists orders (
  id text primary key, principal_kind text not null, principal_id text not null, idempotency_key text, body_hash text,
  mode text not null, venue text not null, network text not null, instrument text not null, market_kind text not null, side text not null, type text not null,
  reduce_only boolean not null default false, account_id text, mandate_id uuid, canonical jsonb, order_hash text,
  record jsonb not null, state text not null, reason text not null, version int not null default 0, reject_code text,
  engine text not null, engine_ref text, engine_sig text, request_expires_at timestamptz, notional_usd numeric, origin text not null default 'trading_api',
  projection_error text, next_reconcile_at timestamptz, detail jsonb not null default '{}', created_at timestamptz not null, updated_at timestamptz not null);
create unique index if not exists orders_idempotency on orders (principal_kind, principal_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists orders_engine_ref on orders (engine, engine_ref) where engine_ref is not null;
create index if not exists orders_recent on orders (created_at desc);
create index if not exists orders_open on orders (state) where state not in ('FILLED', 'CANCELLED', 'REJECTED', 'FAILED');
create index if not exists orders_principal on orders (principal_kind, principal_id, created_at desc);
create table if not exists order_events (
  order_id text not null references orders(id), seq int not null, from_state text not null, to_state text not null, event text not null, body jsonb not null,
  reason text not null, detail text, at timestamptz not null, primary key (order_id, seq));
create or replace function spw_append_only() returns trigger language plpgsql as $spw$ begin raise exception '% is append-only', tg_table_name; end $spw$;
drop trigger if exists order_events_append_only on order_events;
create trigger order_events_append_only before update or delete on order_events for each row execute function spw_append_only();
create table if not exists order_projection_queue (id bigserial primary key, engine text not null, ref text not null, queued_at timestamptz not null default now());
create or replace function spw_queue_deriv_order() returns trigger language plpgsql as $spw$
begin insert into order_projection_queue (engine, ref) values ('deriv', new.account_id::text || ':' || new.client_id); return null; end $spw$;
create or replace function spw_queue_gmx_op() returns trigger language plpgsql as $spw$
begin insert into order_projection_queue (engine, ref) values ('gmx', new.id::text); return null; end $spw$;
drop trigger if exists deriv_orders_projection on deriv_orders;
create trigger deriv_orders_projection after insert or update on deriv_orders for each row execute function spw_queue_deriv_order();
drop trigger if exists deriv_gmx_ops_projection on deriv_gmx_ops;
create trigger deriv_gmx_ops_projection after insert or update on deriv_gmx_ops for each row execute function spw_queue_gmx_op();
-- every evaluation of the unified risk engine (allowed or denied, previews included), linked to the order when there is one
create table if not exists risk_decisions (
  id bigserial primary key, at timestamptz not null, order_id text, client_order_id text, kind text not null, preview boolean not null default false,
  principal_kind text not null, principal_id text not null, mode text not null, venue text not null, instrument text,
  decision text not null, reducing boolean not null, failed text[] not null default '{}', checks jsonb not null, derived jsonb, limits jsonb, context jsonb,
  fingerprint text);
create index if not exists risk_decisions_recent on risk_decisions (id desc);
create index if not exists risk_decisions_order on risk_decisions (client_order_id);
-- trading mandates SPW-TRADING-MANDATE-v1: immutable once created; state and the usage counters are the only things that change
create table if not exists trading_mandates (
  id uuid primary key, principal_kind text not null, principal_id text not null, mode text not null, mandate jsonb not null, hash text not null,
  state text not null, enforcement jsonb not null default '[]', compiled jsonb, signer jsonb, revocation jsonb, stop jsonb,
  created_at timestamptz not null default now(), approved_at timestamptz, revoked_at timestamptz, updated_at timestamptz not null default now());
create index if not exists trading_mandates_principal on trading_mandates (principal_kind, principal_id, created_at desc);
create table if not exists trading_mandate_usage (
  mandate_id uuid primary key references trading_mandates(id), orders_accepted int not null default 0, orders_rejected int not null default 0, consecutive_rejects int not null default 0,
  notional_total numeric not null default 0, peak_equity numeric, start_equity numeric, last_order_at timestamptz, signer_unreachable_since timestamptz, updated_at timestamptz not null default now());
-- <<< v11 execution
-- >>> v11 trading agents runtime (services/api/src/agent-runtime): additive. An agent gets a family, a template, an engine
-- ('bar' = the two bar engines, 'stream' = the sub-bar engine, 'supervisor' = the risk manager), a versioned configuration and a
-- persistent runtime state. Every record that paper and live share carries its MODE; nothing reads them without it.
alter table agents add column if not exists family text;
alter table agents add column if not exists template text;
alter table agents add column if not exists engine text not null default 'bar';
alter table agents add column if not exists config_version int not null default 1;
alter table agents add column if not exists runtime jsonb not null default '{}';
update agents a set family = coalesce((select case
    when v.name ~ '(momentum|trend|breakout|donchian)' then 'momentum' when v.name ~ 'reversion' then 'mean_reversion'
    when v.name ~ '(pairs|coint|statarb)' then 'stat_arb' when v.name ~ '(funding|carry|basis)' then 'funding_arb' else 'custom' end
  from strategy_versions v where v.id = a.strategy_version_id), 'custom') where a.family is null;
-- who approved a strategy version: only an approval by the owner can be pinned by a LIVE mandate (a key may start paper trading)
alter table strategy_versions add column if not exists approved_by text;
update strategy_versions set approved_by = 'owner' where approved_by is null and status in ('approved', 'retired') and approved_at is not null;
-- every configuration an agent ever ran with: a change creates a version, the running version is written on each signal and order
create table if not exists agent_config_versions (
  agent_id uuid not null references agents(id) on delete cascade, version int not null, config jsonb not null, config_sha256 text not null,
  actor text not null default 'migration', reason text not null default '', created_at timestamptz not null default now(), primary key (agent_id, version));
insert into agent_config_versions (agent_id, version, config, config_sha256, actor, reason)
  select a.id, 1, c.config, encode(sha256(convert_to(c.config::text, 'UTF8')), 'hex'), 'migration', 'configuration at the V11 migration'
  from agents a cross join lateral (select jsonb_build_object('kind', a.kind, 'family', a.family, 'network', a.network, 'universe', a.universe, 'interval', a.interval, 'cash', a.cash,
    'capitalUsdc', a.capital_usdc::text, 'risk', a.risk, 'strategyVersionId', a.strategy_version_id) as config) c
  on conflict (agent_id, version) do nothing;
-- the trading mode an agent was in at a given time, from the audit chain (go-live and paper-start events): the backfill of the mode columns
create or replace function spw_agent_mode_at(p_agent uuid, p_at timestamptz) returns text language sql stable as $$
  select coalesce((select case when e.type in ('mandate.approved', 'agent.perp_live') then 'LIVE' else 'PAPER' end from audit_events e
    where ((e.type = 'mandate.approved' and e.data->>'agent' = p_agent::text) or (e.type = 'agent.perp_live' and e.data->>'id' = p_agent::text)
        or (e.type = 'agent.mode' and e.data->>'id' = p_agent::text and e.data->>'state' = 'PAPER_TRADING'))
      and e.ts::timestamptz <= p_at order by e.seq desc limit 1), 'RESEARCH') $$;
-- the journal: research_log + mode, severity, a structured code, the configuration version and a reference (signal, order, job)
alter table research_log add column if not exists mode text;
alter table research_log add column if not exists severity text not null default 'info';
alter table research_log add column if not exists code text;
alter table research_log add column if not exists config_version int;
alter table research_log add column if not exists ref jsonb;
update research_log l set mode = spw_agent_mode_at(l.agent_id, l.ts) where l.mode is null and l.agent_id is not null;
create index if not exists research_log_agent_mode on research_log (agent_id, mode, id desc);
-- a writer that does not name the mode (older call sites) gets the agent's current one: no journal line is ever mode-less
create or replace function spw_research_log_defaults() returns trigger language plpgsql as $$
begin
  if new.agent_id is not null and (new.mode is null or new.config_version is null) then
    select coalesce(new.mode, upper(a.mode)), coalesce(new.config_version, a.config_version) into new.mode, new.config_version from agents a where a.id = new.agent_id;
  end if;
  return new;
end $$;
drop trigger if exists research_log_defaults on research_log;
create trigger research_log_defaults before insert on research_log for each row execute function spw_research_log_defaults();
-- signals of every agent kind (perp_agent_signals generalised; that table is kept and no longer written): one decision per agent, mode and bar
create table if not exists agent_signals (
  id bigserial primary key, agent_id uuid not null references agents(id) on delete cascade, bar timestamptz not null, mode text not null, kind text not null default 'perp',
  config_version int not null default 1, strategy_sha256 text not null, inputs_digest text, status text not null, reason text not null default '',
  decision text not null default 'pending', reason_code text, weights jsonb, scaled jsonb, scale text, equity numeric, targets jsonb, orders jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (agent_id, mode, bar));
create index if not exists agent_signals_recent on agent_signals (agent_id, mode, bar desc);
insert into agent_signals (agent_id, bar, mode, kind, strategy_sha256, status, reason, decision, reason_code, weights, scaled, scale, equity, targets, orders, created_at, updated_at)
  select s.agent_id, s.bar, case spw_agent_mode_at(s.agent_id, s.created_at) when 'LIVE' then 'LIVE' else 'PAPER' end, 'perp', s.strategy_sha256, s.status, s.reason,
    case when s.status = 'hold' then 'skipped' when s.status = 'done' and jsonb_array_length(coalesce(s.orders->'list', '[]'::jsonb)) > 0 then 'acted' when s.status = 'done' then 'skipped' else 'pending' end,
    case when s.status = 'hold' then 'no_valid_signal' when s.status = 'done' and jsonb_array_length(coalesce(s.orders->'list', '[]'::jsonb)) = 0 then 'at_target' else null end,
    s.weights, s.scaled, s.scale, s.equity, s.targets, s.orders, s.created_at, s.updated_at
  from perp_agent_signals s on conflict (agent_id, mode, bar) do nothing;
-- spot orders name the signal, the configuration version and the code that produced them; a client id makes a paper order unrepeatable
alter table agent_orders add column if not exists config_version int;
alter table agent_orders add column if not exists signal_id bigint;
alter table agent_orders add column if not exists strategy_sha256 text;
alter table agent_orders add column if not exists client_order_id text;
create unique index if not exists agent_orders_client on agent_orders (agent_id, client_order_id) where client_order_id is not null;
create index if not exists agent_orders_mode on agent_orders (agent_id, mode, ts desc);
-- the order gateway's ledger (agent-runtime/gateway.ts): one row per order an agent asked for, in the unified states of @spw/trading,
-- written BEFORE the executor is called, so that an order whose outcome is not known is reconciled and never sent again
create table if not exists agent_order_intents (
  id text primary key, client_order_id text not null, attempt int not null default 1, agent_id uuid not null references agents(id) on delete cascade, mode text not null, idempotency_key text not null, body_hash text not null,
  venue text not null, instrument text not null, side text not null, reduce_only boolean not null default false, order_json jsonb not null, record jsonb not null,
  state text not null, reason text not null, history jsonb not null default '[]', fills jsonb not null default '[]', signal_id bigint, config_version int, strategy_sha256 text, venue_status text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (agent_id, idempotency_key, attempt));
create index if not exists agent_order_intents_agent on agent_order_intents (agent_id, mode, created_at desc);
create index if not exists agent_order_intents_open on agent_order_intents (agent_id) where state in ('SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'UNKNOWN');
-- one worker at a time per agent: a lease row with a heartbeat and a fencing token (agent-runtime/leases.ts)
create table if not exists agent_leases (
  agent_id uuid primary key references agents(id) on delete cascade, owner text not null, token bigint not null default 1, acquired_at timestamptz not null, heartbeat_at timestamptz not null, expires_at timestamptz not null);
-- durable tasks of the agents: tick, backtest, wind_down — retries with backoff, then dead-letter (agent-runtime/queue.ts)
create table if not exists agent_jobs (
  id uuid primary key, agent_id uuid references agents(id) on delete cascade, kind text not null, payload jsonb not null default '{}', state text not null default 'queued',
  attempts int not null default 0, max_attempts int not null default 5, run_at timestamptz not null default now(), locked_by text, locked_until timestamptz,
  last_error text, result jsonb, dedupe_key text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), finished_at timestamptz);
create unique index if not exists agent_jobs_dedupe on agent_jobs (dedupe_key) where dedupe_key is not null and state in ('queued', 'running');
create index if not exists agent_jobs_due on agent_jobs (run_at) where state = 'queued';
create index if not exists agent_jobs_agent on agent_jobs (agent_id, created_at desc);
-- what the stream engine consumed, compact: top of book + mark + funding at a fixed cadence, pruned; and every hole in it
create table if not exists market_snapshots (
  venue text not null, symbol text not null, ts timestamptz not null, bid numeric, bid_size numeric, ask numeric, ask_size numeric, mark numeric, index_price numeric,
  funding numeric, funding_interval_sec int, source_ts timestamptz, primary key (venue, symbol, ts));
create table if not exists market_snapshot_gaps (
  id bigserial primary key, venue text not null, symbol text not null, ts timestamptz not null, kind text not null, detail text not null default '', duration_ms bigint);
create index if not exists market_snapshot_gaps_recent on market_snapshot_gaps (venue, symbol, ts desc);
-- v11.2 (agents bound to the execution layer). ONE ORDER TRUTH: when an agent's order is a row of the unified "orders" table
-- (order_id is set), its agent_order_intents row is CONTEXT ONLY — signal, configuration version, strategy hash — and carries no
-- state, no record, no history and no fills: those are READ from "orders" / "order_events". The constraint makes the two unable
-- to disagree: a row cannot both point to a unified order and hold a state of its own. Rows without order_id are the seam
-- gateway's ledger (spot swaps, the stream agents' simulated books), which are not unified orders.
alter table agent_order_intents add column if not exists order_id text;
alter table agent_order_intents alter column record drop not null;
alter table agent_order_intents alter column state drop not null;
alter table agent_order_intents alter column reason drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agent_order_intents_one_truth') then
    alter table agent_order_intents add constraint agent_order_intents_one_truth check (
      (order_id is null and state is not null and record is not null and reason is not null)
      or (order_id is not null and order_id = id and state is null and record is null and reason is null and history = '[]'::jsonb and fills = '[]'::jsonb and venue_status is null));
  end if;
end $$;
create index if not exists agent_order_intents_order on agent_order_intents (order_id) where order_id is not null;
-- v11.2 ONE KILL SWITCH: the agents-side flag (settings 'agents.kill_switch', released without a passkey) no longer exists.
-- A flag that was engaged is carried into the risk engine's switch (released with the passkey only), then the key is deleted.
do $$ declare old jsonb; cur jsonb; begin
  select value into old from settings where key = 'agents.kill_switch';
  if old is not null then
    if coalesce((old->>'engaged')::boolean, false) then
      select value into cur from settings where key = 'risk.switches';
      if not coalesce((cur->'killSwitch'->>'on')::boolean, false) then
        insert into settings (key, value) values ('risk.switches', jsonb_build_object(
          'killSwitch', jsonb_build_object('on', true, 'at', coalesce(old->'at', to_jsonb((extract(epoch from now()) * 1000)::bigint)), 'by', jsonb_build_object('kind', 'system', 'id', 'migration:agents.kill_switch'),
            'reason', left(coalesce(old->>'reason', '') || ' (engaged on the agents-side switch, by ' || coalesce(old->>'by', '?') || ')', 200)),
          'readOnly', coalesce(cur->'readOnly', '{"on":false,"at":null,"by":null,"reason":null}'::jsonb)))
        on conflict (key) do update set value = excluded.value;
      end if;
    end if;
    delete from settings where key = 'agents.kill_switch';
  end if;
end $$;
-- <<< v11 trading agents runtime
`;

export async function migrate(): Promise<void> { await sql.unsafe(SCHEMA); }

let auditLock: Promise<unknown> = Promise.resolve();
/** Append to the tamper-evident hash chain. Never pass secrets or assertion payloads here. */
export function audit(type: string, actor: string, data: Record<string, unknown> = {}): Promise<void> {
  const run = async () => {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7707001)`;
      const [last] = await tx<AuditRecord[]>`select seq::int as seq, ts, type, actor, data, prev, hash from audit_events order by seq desc limit 1`;
      const rec = appendAudit(last ?? null, type, actor, data);
      await tx`insert into audit_events (seq, ts, type, actor, data, prev, hash) values (${rec.seq}, ${rec.ts}, ${rec.type}, ${rec.actor}, ${tx.json(rec.data as never)}, ${rec.prev}, ${rec.hash})`;
    });
  };
  const p = auditLock.then(run, run);
  auditLock = p.catch(() => {});
  return p;
}

export async function auditList(limit: number): Promise<{ events: AuditRecord[]; intact: boolean; brokenAt: number | null; total: number }> {
  const all = await sql<AuditRecord[]>`select seq::int as seq, ts, type, actor, data, prev, hash from audit_events order by seq asc`;
  const brokenAt = verifyAuditChain(all);
  return { events: all.slice(-limit).reverse(), intact: brokenAt === null, brokenAt, total: all.length };
}

export async function getSetting<T>(key: string, dflt: T): Promise<T> {
  const [r] = await sql<{ value: T }[]>`select value from settings where key = ${key}`;
  return r ? r.value : dflt;
}
export async function setSetting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (key, value) values (${key}, ${sql.json(value as never)}) on conflict (key) do update set value = excluded.value`;
}
