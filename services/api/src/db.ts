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
-- v11 exec2: the owner's passkey approval of the FULL trading mandate hash (intent + assertion), verified again at every use
alter table trading_mandates add column if not exists approval jsonb;
create table if not exists trading_mandate_usage (
  mandate_id uuid primary key references trading_mandates(id), orders_accepted int not null default 0, orders_rejected int not null default 0, consecutive_rejects int not null default 0,
  notional_total numeric not null default 0, peak_equity numeric, start_equity numeric, last_order_at timestamptz, signer_unreachable_since timestamptz, updated_at timestamptz not null default now());
-- v11 exec2 — spot. The owner's swaps (proposals, kind = 'swap') and the spot agents' swaps (agent_orders) are projected onto the
-- unified order table like the venue engines' rows: a trigger queues every change, orders/spot.ts turns it into events.
create or replace function spw_queue_swap() returns trigger language plpgsql as $spw$
begin if new.kind = 'swap' then insert into order_projection_queue (engine, ref) values ('swap', new.id::text); end if; return null; end $spw$;
drop trigger if exists proposals_swap_projection on proposals;
create trigger proposals_swap_projection after insert or update on proposals for each row execute function spw_queue_swap();
create or replace function spw_queue_agent_order() returns trigger language plpgsql as $spw$
begin insert into order_projection_queue (engine, ref) values ('agent_swap', new.id::text); return null; end $spw$;
drop trigger if exists agent_orders_projection on agent_orders;
create trigger agent_orders_projection after insert or update on agent_orders for each row execute function spw_queue_agent_order();
-- the global kill switch and read-only mode (settings 'risk.switches', risk/service.ts), applied to a spot agent's order at the
-- only point this layer owns: the row itself. Read-only: no order is recorded. Kill switch: an order that BUYS risk (it spends
-- the agent's cash leg) is refused; a sale into the cash leg passes. Paper and live alike: the paper engine and the live engine
-- both insert the row before anything else happens (agents/engine.ts, agents/live.ts placeLive — before the signer is asked).
create or replace function spw_agent_order_gate() returns trigger language plpgsql as $spw$
declare sw jsonb; v_cash text;
begin
  select value into sw from settings where key = 'risk.switches';
  if sw is null then return new; end if;
  if coalesce((sw->'readOnly'->>'on')::boolean, false) then
    raise exception 'read_only_mode: read-only mode is on: no order of a spot agent is recorded (only cancels are permitted)';
  end if;
  if coalesce((sw->'killSwitch'->>'on')::boolean, false) then
    select a.cash into v_cash from agents a where a.id = new.agent_id;
    if new.from_symbol = coalesce(v_cash, 'USDC') then
      raise exception 'kill_switch_active: the kill switch is on: a spot agent buys no risk (a sale into its cash leg still passes)';
    end if;
  end if;
  return new;
end $spw$;
drop trigger if exists agent_orders_gate on agent_orders;
create trigger agent_orders_gate before insert on agent_orders for each row execute function spw_agent_order_gate();
-- v11 exec2 — stop-loss / take-profit attached to an order by a command: placed only once the parent has filled, sized to what
-- filled (orders/attached.ts). One row per (parent, role); the children are ordinary unified orders.
create table if not exists order_attachments (
  id text primary key, parent_id text not null references orders(id), role text not null, template jsonb not null, caller jsonb not null, account_id text,
  idem text not null, state text not null default 'pending', placed numeric not null default 0, children jsonb not null default '[]', attempts int not null default 0,
  reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists order_attachments_open on order_attachments (parent_id) where state <> 'closed';
-- <<< v11 execution
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
