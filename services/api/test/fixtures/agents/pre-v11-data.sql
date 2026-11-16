-- Production-like agents in the PRE-V11 shape (applied after pre-v11-schema.sql, before the V11 migration runs).
--   "Test"          spot, Base, ETH. Paper from 2 Nov, LIVE under a mandate from 5 Nov, stopped by the engine on 8 Nov.
--   "Eth test"      spot, Base, ETH. Paper trading since 10 Nov, still running (the agent the migration must keep ticking).
--   "Perp fixture"  perp, BTC/ETH. Paper from 4 Nov, on a venue account from 7 Nov: three rows of the old perp_agent_signals.
-- The audit chain carries the events from which the migration derives each record's mode. Hashes are placeholders: the
-- migration reads types, times and data, never the chain's integrity.
insert into agents (id, name, mission, state, mode, network, universe, interval, risk, vault_index, vault_address, capital_usdc, strategy_version_id, mandate_id, mandate, last_bar, stop_reason, created_at, updated_at, cash, assets, kind) values
 ('11111111-1111-4111-8111-111111111111', 'Test', '', 'STOPPED', 'LIVE', 'base', '["ETH"]', '1h', '{"maxExposurePct":50,"maxLossPct":5,"maxOrderUsd":25,"maxDailyUsd":100,"maxOrdersPerDay":12,"mandateDays":30,"slippageBps":50}', 1,
  '0x1111111111111111111111111111111111111111', 100000000, 'aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111',
  '{"v":1,"mandateId":"bbbbbbbb-1111-4111-8111-111111111111","strategySha256":"1111111111111111111111111111111111111111111111111111111111111111","expiresAt":1797000000,"label":"Test","maxOrdersPerDay":12}',
  '2026-11-08T09:00:00Z', 'loss limit reached', '2026-11-01T10:00:00Z', '2026-11-08T10:00:00Z', 'USDC', '{"ETH":"native"}', 'spot'),
 ('22222222-2222-4222-8222-222222222222', 'Eth test', 'paper only', 'PAPER_TRADING', 'PAPER', 'base', '["ETH"]', '1h', '{"maxExposurePct":50,"maxLossPct":5,"maxOrderUsd":25,"maxDailyUsd":100,"maxOrdersPerDay":12,"mandateDays":30,"slippageBps":50}', 2,
  '0x2222222222222222222222222222222222222222', 100000000, 'aaaaaaaa-2222-4222-8222-222222222222', null, null, '2026-11-12T08:00:00Z', null, '2026-11-10T09:00:00Z', '2026-11-12T08:01:00Z', 'USDC', '{"ETH":"native"}', 'spot');
insert into agents (id, name, state, mode, network, universe, interval, risk, vault_index, vault_address, capital_usdc, strategy_version_id, kind, deriv_account_id, perp, live_account_id, last_bar, created_at, updated_at) values
 ('33333333-3333-4333-8333-333333333333', 'Perp fixture', 'STOPPED', 'LIVE', 'hyperliquid', '["BTC","ETH"]', '1h', '{"maxLeverage":2,"maxGrossExposureX":1.5,"maxPositionX":1,"maxDailyLossPct":3,"maxTotalLossPct":10,"slippageBps":30,"minTradePct":2}', -1, '', 1000000000,
  'aaaaaaaa-3333-4333-8333-333333333333', 'perp', 'cccccccc-3333-4333-8333-333333333333',
  '{"live":{"accountId":"dddddddd-3333-4333-8333-333333333333","network":"testnet","mandateId":"eeeeeeee-3333-4333-8333-333333333333","strategySha256":"3333333333333333333333333333333333333333333333333333333333333333","since":1794000000000,"capital":"1000","exit":{"ts":1794200000000,"code":"owner_stop","reason":"stopped by the owner","done":1794200100000}}}',
  null, '2026-11-08T00:00:00Z', '2026-11-04T09:00:00Z', '2026-11-09T00:00:00Z');

insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report, created_at, approved_at) values
 ('aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'mean_reversion', '3', '1111111111111111111111111111111111111111111111111111111111111111', 'strategies/mean_reversion/3', '{"name":"mean_reversion","version":"3","universe":["*"],"interval":"1h","lookback":200}', 'approved', '{"checks":{"lookahead":"pass"}}', '2026-11-01T11:00:00Z', '2026-11-02T09:00:00Z'),
 ('aaaaaaaa-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'ma_trend', '3', '2222222222222222222222222222222222222222222222222222222222222222', 'strategies/ma_trend/3', '{"name":"ma_trend","version":"3","universe":["*"],"interval":"1h","lookback":1000}', 'approved', '{"checks":{"lookahead":"pass"}}', '2026-11-10T09:10:00Z', '2026-11-10T09:50:00Z'),
 ('aaaaaaaa-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'pairs_coint_perp', '1', '3333333333333333333333333333333333333333333333333333333333333333', 'strategies/pairs_coint_perp/1', '{"kind":"perp","name":"pairs_coint_perp","version":"1","universe":["BTC","ETH"],"interval":"1h","lookback":800,"max_leverage":2,"max_gross_exposure":2}', 'approved', '{"schema_version":2}', '2026-11-04T09:10:00Z', '2026-11-04T09:50:00Z');

insert into audit_events (seq, ts, type, actor, data, prev, hash) values
 (1, '2026-11-01T10:00:00.000Z', 'agent.created', 'owner', '{"id":"11111111-1111-4111-8111-111111111111","name":"Test"}', 'genesis', 'h1'),
 (2, '2026-11-02T10:00:00.000Z', 'agent.mode', 'owner', '{"id":"11111111-1111-4111-8111-111111111111","state":"PAPER_TRADING"}', 'h1', 'h2'),
 (3, '2026-11-04T10:00:00.000Z', 'agent.mode', 'owner', '{"id":"33333333-3333-4333-8333-333333333333","kind":"perp","state":"PAPER_TRADING"}', 'h2', 'h3'),
 (4, '2026-11-05T10:00:00.000Z', 'mandate.approved', 'owner', '{"agent":"11111111-1111-4111-8111-111111111111","mandateId":"bbbbbbbb-1111-4111-8111-111111111111"}', 'h3', 'h4'),
 (5, '2026-11-07T10:00:00.000Z', 'agent.perp_live', 'owner', '{"id":"33333333-3333-4333-8333-333333333333","network":"testnet"}', 'h4', 'h5'),
 (6, '2026-11-08T10:00:00.000Z', 'agent.stopped', 'engine', '{"id":"11111111-1111-4111-8111-111111111111","reason":"loss limit reached"}', 'h5', 'h6'),
 (7, '2026-11-10T10:00:00.000Z', 'agent.mode', 'owner', '{"id":"22222222-2222-4222-8222-222222222222","state":"PAPER_TRADING"}', 'h6', 'h7'),
 (8, '2026-11-10T10:00:01.000Z', 'mandate.approved', 'owner', '{"account":"some-venue-account","mandateId":"a derivative mandate of the live module: no agent key"}', 'h7', 'h8');

insert into research_log (agent_id, ts, kind, title, body) values
 ('11111111-1111-4111-8111-111111111111', '2026-11-01T12:00:00Z', 'research', 'Research job submitted', 'before any trading'),
 ('11111111-1111-4111-8111-111111111111', '2026-11-03T12:00:00Z', 'hold', 'No valid signal: holding', 'on paper'),
 ('11111111-1111-4111-8111-111111111111', '2026-11-06T12:00:00Z', 'hold', 'Order not placed', 'under the mandate'),
 ('11111111-1111-4111-8111-111111111111', '2026-11-08T09:59:59Z', 'stop', 'Agent stopped', 'loss limit reached'),
 ('11111111-1111-4111-8111-111111111111', '2026-11-09T12:00:00Z', 'stop', 'Mandate not revoked yet', 'after the stop'),
 ('22222222-2222-4222-8222-222222222222', '2026-11-10T11:00:00Z', 'hold', 'No valid signal: holding', 'paper'),
 (null, '2026-11-10T11:00:00Z', 'research', 'A line without an agent', '');

insert into agent_orders (id, agent_id, ts, mode, from_asset, to_asset, from_symbol, to_symbol, amount_in, expected_out, received, state, reason, txid, bar, aux) values
 ('0a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '2026-11-03T13:00:00Z', 'PAPER', '0xusdc', 'native', 'USDC', 'ETH', 25000000, 10000000000000000, 10000000000000000, 'filled', 'target 50.0 %', null, '2026-11-03T12:00:00Z', '{"usd":25}'),
 ('0a000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '2026-11-06T13:00:00Z', 'LIVE', '0xusdc', 'native', 'USDC', 'ETH', 20000000, 8000000000000000, 7990000000000000, 'filled', 'target 50.0 %', '0xfeed', '2026-11-06T12:00:00Z', '{"usd":20}'),
 ('0a000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', '2026-11-10T12:00:00Z', 'PAPER', '0xusdc', 'native', 'USDC', 'ETH', 25000000, 10000000000000000, 10000000000000000, 'filled', 'target 50.0 %', null, '2026-11-10T11:00:00Z', '{"usd":25}');
insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values
 ('11111111-1111-4111-8111-111111111111', '2026-11-03T12:00:00Z', 'PAPER', 100, '{"USDC":75,"ETH":0.01}'),
 ('11111111-1111-4111-8111-111111111111', '2026-11-04T12:00:00Z', 'PAPER', 104, '{"USDC":75,"ETH":0.01}'),
 ('11111111-1111-4111-8111-111111111111', '2026-11-06T12:00:00Z', 'LIVE', 50, '{"USDC":30,"ETH":0.008}'),
 ('11111111-1111-4111-8111-111111111111', '2026-11-07T12:00:00Z', 'LIVE', 47, '{"USDC":30,"ETH":0.008}'),
 ('22222222-2222-4222-8222-222222222222', '2026-11-10T11:00:00Z', 'PAPER', 100, '{"USDC":75,"ETH":0.01}'),
 ('22222222-2222-4222-8222-222222222222', '2026-11-12T08:00:00Z', 'PAPER', 101.5, '{"USDC":75,"ETH":0.01}');
insert into agent_paper (agent_id, symbol, units) values ('22222222-2222-4222-8222-222222222222', 'USDC', 75), ('22222222-2222-4222-8222-222222222222', 'ETH', 0.01);

insert into perp_agent_signals (agent_id, bar, status, reason, strategy_sha256, weights, scaled, scale, equity, targets, orders, created_at, updated_at) values
 ('33333333-3333-4333-8333-333333333333', '2026-11-05T00:00:00Z', 'done', '', '3333333333333333333333333333333333333333333333333333333333333333', '{"BTC":0.5,"ETH":-0.4}', '{"BTC":"0.5","ETH":"-0.4"}', '1', 1000, '{"BTC":"0.005","ETH":"-0.16"}',
  '{"binding":"none","list":[{"symbol":"BTC","side":"buy","status":"filled","clientId":"ag-x-1"}]}', '2026-11-05T00:01:00Z', '2026-11-05T00:01:05Z'),
 ('33333333-3333-4333-8333-333333333333', '2026-11-06T00:00:00Z', 'hold', 'signal timed out', '3333333333333333333333333333333333333333333333333333333333333333', null, null, null, null, null, null, '2026-11-06T00:01:00Z', '2026-11-06T00:01:00Z'),
 ('33333333-3333-4333-8333-333333333333', '2026-11-08T00:00:00Z', 'done', '', '3333333333333333333333333333333333333333333333333333333333333333', '{"BTC":0.5,"ETH":-0.4}', '{"BTC":"0.5","ETH":"-0.4"}', '1', 990, '{"BTC":"0.005","ETH":"-0.16"}',
  '{"binding":"none","list":[]}', '2026-11-08T00:01:00Z', '2026-11-08T00:01:05Z');
