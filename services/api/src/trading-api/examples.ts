/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/examples.ts
 * Module           : trading-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// One worked example per operation of spec.ts — the request (path parameters, query, body), the answer, and the same call
// in both SDKs. Pure data: the OpenAPI document (openapi.ts), the served reference and docs/TRADING-API-REFERENCE.md
// (reference.ts) are rendered from it.
//
// Where an answer says `recorded`, it is the real answer of the real server (examples-data.ts says how it was taken). The
// few that could not be produced on the test stack — an NFT the test wallet does not hold, the OpenAPI document itself — are written
// from the schema and marked `recorded: false`; the reference shows that mark.
//
// services/api/test/trading-api-docs.test.ts keeps this file honest: every operation has an example, every request passes
// the operation's own zod schemas (params, query, body), every answer passes its response schema, and every SDK method a
// snippet calls exists in packages/trading-sdk and in sdk/python.
import { RECORDED } from './examples-data.ts';

export interface OperationExample {
  /** path parameters, by name (not URL-encoded: the renderers encode them) */
  params?: Record<string, string>;
  query?: Record<string, string | number>;
  body?: unknown;
  /** the JSON body of the 200 answer */
  response: unknown;
  /** true: `response` was recorded from the real server; false: written from the schema */
  recorded: boolean;
  /** the call with @sp-wallet/trading-sdk (`client` is an `SPWallet`) */
  ts: string;
  /** the call with sp-wallet-python (`client` is an `SPWallet`) */
  py: string;
  /** one line shown under the example */
  note?: string;
}

const rec = (name: string): unknown => { const v = RECORDED[name]; if (v === undefined) throw new Error(`examples: no recorded answer '${name}'`); return v; };

// identifiers of the recorded session (a throwaway database): they tie the examples together, they open nothing
const ORDER = '0xff18683e8e2aa319d3812cf8a47fc261', RESTING = '0x0276bab16d117c8323ee375b61b01d1d';
const POSITION = 'paper:hyperliquid:6a2c8351-cd79-44e2-b75a-f39280d0ebc2:hyperliquid:BTC';
const AGENT = 'b9180e9d-3977-403c-a072-9af105bfd59b', PERP_AGENT = 'fa9c1fd9-a005-4825-bd67-ea180a2eb83d', JOB = '72526d3e-9b2a-4f86-977b-07b6531868a8', STRATEGY = '450bc266-e1a9-4807-9113-7da6773ddb4e';
const NFT_KEY = 'evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1', BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const MARKET_ORDER = { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notional: '100' };
const TS_ORDER = `{ mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notional: '100' }`;
const PY_ORDER = `mode="paper", instrument="hyperliquid:BTC", side="buy", order_type="market", notional="100"`;
const WALLET = '0x00000000000000000000000000000000000000aa';

export const EXAMPLES: Record<string, OperationExample> = {
  // ------------------------------------------------------------------------------------------------------------ meta
  getOpenApi: { recorded: false, response: { openapi: '3.1.0', info: { title: 'SP Trading API', version: '1.0.0' }, paths: { '/api/v1/trading/markets': { get: { operationId: 'listMarkets' } } } },
    ts: `const doc = await client.openapi();`, py: `doc = client.openapi()`, note: 'Cut: the real document describes every operation, schema and error code.' },

  // ------------------------------------------------------------------------------------------------------------ markets
  listMarkets: { recorded: true, query: { venue: 'hyperliquid', q: 'BTC', limit: 3 }, response: rec('listMarkets'),
    ts: `const { markets } = await client.listMarkets({ venue: 'hyperliquid', q: 'BTC', limit: 3 });`, py: `markets = client.list_markets(venue="hyperliquid", q="BTC", limit=3).markets` },
  compareMarkets: { recorded: true, query: { underlying: 'BTC', side: 'long', notional: '1000', leverage: '2' }, response: rec('compareMarkets'),
    ts: `const cmp = await client.compareMarkets({ underlying: 'BTC', side: 'long', notional: '1000', leverage: '2' });`, py: `cmp = client.compare_markets(underlying="BTC", side="long", notional="1000", leverage="2")`,
    note: 'Cut to one row and one discrepancy. dYdX and edgeX rows are information: `tradable` is false on them.' },
  getMarket: { recorded: true, params: { symbol: 'hyperliquid:BTC' }, response: rec('getMarket'),
    ts: `const { instrument, ticker } = await client.getMarket('hyperliquid:BTC');`, py: `market = client.get_market("hyperliquid:BTC")` },
  getOrderbook: { recorded: true, params: { symbol: 'hyperliquid:BTC' }, query: { depth: 3 }, response: rec('getOrderbook'),
    ts: `const book = await client.getOrderbook('hyperliquid:BTC', { depth: 3 });`, py: `book = client.get_orderbook("hyperliquid:BTC", depth=3)` },
  getCandles: { recorded: true, params: { symbol: 'hyperliquid:BTC' }, query: { interval: '1h', limit: 3 }, response: rec('getCandles'),
    ts: `const { candles } = await client.getCandles('hyperliquid:BTC', { interval: '1h', limit: 3 });`, py: `candles = client.get_candles("hyperliquid:BTC", interval="1h", limit=3).candles` },
  listPrivateMarkets: { recorded: true, response: rec('listPrivateMarkets'),
    ts: `const { markets, companies } = await client.listPrivateMarkets();`, py: `private = client.list_private_markets()`, note: 'Cut to one market. Display only: `tradable` is always false.' },
  getPrivateMarketCompany: { recorded: true, params: { slug: 'anthropic' }, response: rec('getPrivateMarketCompany'),
    ts: `const company = await client.getPrivateMarketCompany('anthropic');`, py: `company = client.get_private_market_company("anthropic")`, note: 'Cut to one contract.' },
  getPrivateMarket: { recorded: true, params: { id: 'hyperliquid:io:ANTH' }, query: { interval: '1d', limit: 3 }, response: rec('getPrivateMarket'),
    ts: `const pm = await client.getPrivateMarket('hyperliquid:io:ANTH', { interval: '1d', limit: 3 });`, py: `pm = client.get_private_market("hyperliquid:io:ANTH", interval="1d", limit=3)` },

  // ------------------------------------------------------------------------------------------------------------ portfolio
  getPortfolio: { recorded: true, response: rec('getPortfolio'),
    ts: `const portfolio = await client.getPortfolio();`, py: `portfolio = client.get_portfolio()`, note: 'Cut to one balance. The test wallet is empty; `totals` are three separate figures, never summed.' },
  getBalances: { recorded: true, query: { network: 'base' }, response: rec('getBalances'),
    ts: `const { balances } = await client.getBalances({ network: 'base' });`, py: `balances = client.get_balances(network="base").balances` },
  getActivity: { recorded: true, query: { limit: 2 }, response: rec('getActivity'),
    ts: `const page = await client.getActivity({ limit: 2 });\nfor await (const item of client.iterateActivity()) console.log(item.kind, item.at);   // every page`,
    py: `page = client.get_activity(limit=2)\nfor item in client.iter_activity():   # every page\n    print(item.kind, item.at)` },

  // ------------------------------------------------------------------------------------------------------------ NFTs
  listNfts: { recorded: true, query: { limit: 2 }, response: rec('listNfts'),
    ts: `const { items, nextCursor } = await client.listNfts({ limit: 2 });`, py: `nfts = client.list_nfts(limit=2)`, note: 'The test wallet holds no NFT: the list is empty, and `valuation` is always `unavailable`.' },
  getNft: { recorded: false, query: { key: NFT_KEY },
    response: { nft: { key: NFT_KEY, network: 'ethereum', family: 'evm', standard: 'erc721', assetId: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1', contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', tokenId: '1', mintAddress: null,
      quantity: '1', name: 'Example #1', onchainName: null, collection: { key: 'evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', id: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', name: 'Example Collection', verifiedOnChain: { state: 'unsupported' } },
      state: 'held', inWallet: true, transferable: true, transferBlockedBy: [], spam: null, ownershipSource: { category: 'onchain', source: 'rpc:ownerOf', confidence: 'confirmed', fetchedAt: '2026-11-17T22:15:29.000Z', stale: false },
      ownership: { state: 'held', owner: { state: 'known', value: WALLET }, heldByWallet: true },
      metadata: { status: 'ok', name: 'Example #1', description: 'Declared by the creator.', attributes: [{ traitType: 'Background', value: 'Blue' }] },
      sources: [{ category: 'onchain', source: 'rpc:ownerOf', stale: false }, { category: 'creator_metadata', source: 'tokenURI', stale: false }] },
    marketActions: [{ id: 'sell', available: false, reason: 'market_writes_not_built' }] },
    ts: `const { nft } = await client.getNft('${NFT_KEY}');`, py: `nft = client.get_nft("${NFT_KEY}").nft` },
  getNftActivity: { recorded: false, query: { key: NFT_KEY, limit: 2 },
    response: { key: NFT_KEY, events: [{ id: '0x5c1f…e2a9:14', type: 'transfer-in', tx: '0x5c1f0d2b7a9e4c3f8b6a1d0e9f7c5b3a2d1e0f9c8b7a6d5e4f3c2b1a0f9ee2a9', at: '2026-10-02T14:11:23.000Z', from: '0x00000000000000000000000000000000000000bb', to: WALLET,
      quantity: '1', finality: 'final', price: null, interpretedBy: 'chain' }], nextCursor: null, completeness: 'partial', note: null, error: null },
    ts: `const { events } = await client.getNftActivity({ key: '${NFT_KEY}', limit: 2 });`, py: `events = client.get_nft_activity("${NFT_KEY}", limit=2).events`,
    note: 'A transfer has no price: `price` is set only when a decoded marketplace event of the same transaction links a payment.' },
  getNftMarket: { recorded: true, query: { network: 'ethereum', address: BAYC, tokenId: '1' }, response: rec('getNftMarket'),
    ts: `const market = await client.getNftMarket({ network: 'ethereum', address: '${BAYC}', tokenId: '1' });`, py: `market = client.get_nft_market(network="ethereum", address="${BAYC}", token_id="1")`,
    note: 'Recorded on a server without a marketplace key: the source answers `needs_key` and names the variable. Nothing is filled in.' },
  getNftMarketEvents: { recorded: true, query: { network: 'ethereum', address: BAYC, tokenId: '1', type: 'sale', limit: 2 }, response: rec('getNftMarketEvents'),
    note: 'Recorded on a server without a marketplace key: the source answers `needs_key` and lists no event. With a key, each event carries `type`, `at`, `tx`, `from`, `to`, `quantity`, `price` (amount in base units + currency) and `flags.washTrade`.',
    ts: `const { sources } = await client.getNftMarketEvents({ network: 'ethereum', address: '${BAYC}', tokenId: '1', type: 'sale', limit: 2 });`,
    py: `sources = client.get_nft_market_events(network="ethereum", address="${BAYC}", token_id="1", type="sale", limit=2).sources` },

  // ------------------------------------------------------------------------------------------------------------ positions, orders
  listPositions: { recorded: true, query: { mode: 'paper' }, response: rec('listPositions'),
    ts: `const { positions } = await client.getPositions({ mode: 'paper' });`, py: `positions = client.get_positions(mode="paper").positions`,
    note: 'A position `id` contains colons: URL-encode it in a path (both SDKs do).' },
  listOrders: { recorded: true, query: { open: 'true', limit: 5 }, response: rec('listOrders'),
    ts: `const { orders, nextCursor } = await client.listOrders({ open: true, limit: 5 });\nfor await (const order of client.iterateOrders({ open: true })) console.log(order.id, order.status);   // every page`,
    py: `page = client.list_orders(open=True, limit=5)\nfor order in client.iter_orders(open=True):   # every page\n    print(order.id, order.status)` },
  getOrder: { recorded: true, params: { id: ORDER }, response: rec('getOrder'),
    ts: `const { order, fills } = await client.getOrder('${ORDER}');\nconst done = await client.waitForOrder('${ORDER}');   // polls until final; UNKNOWN keeps waiting`,
    py: `detail = client.get_order("${ORDER}")\ndone = client.wait_for_order("${ORDER}")   # polls until final; UNKNOWN keeps waiting`, note: 'Fills and history cut to two entries.' },
  previewOrder: { recorded: true, body: MARKET_ORDER, response: rec('previewOrder'),
    ts: `const preview = await client.previewOrder(${TS_ORDER});\nif (!preview.wouldExecute) console.log(preview.refusals);`, py: `preview = client.preview_order(${PY_ORDER})\nif not preview.would_execute:\n    print(preview.refusals)`,
    note: 'Risk checks cut to two. `wouldExecute` is true exactly when `refusals` is empty.' },
  placeOrder: { recorded: true, body: MARKET_ORDER, response: rec('placeOrder'),
    ts: `const placed = await client.createOrder(${TS_ORDER}, { idempotencyKey: 'bot-2026-11-17-0001' });`, py: `placed = client.create_order(${PY_ORDER}, idempotency_key="bot-2026-11-17-0001")`,
    note: 'A paper market order is filled at once by the paper engine against the real Hyperliquid book: `status` is already `FILLED`.' },
  cancelOrder: { recorded: true, params: { id: RESTING }, response: rec('cancelOrder'),
    ts: `const { order, changed } = await client.cancelOrder('${RESTING}');`, py: `cancelled = client.cancel_order("${RESTING}")`, note: 'Cancelling again answers 200 with `changed: false`.' },
  closePosition: { recorded: true, params: { id: POSITION }, body: {}, response: rec('closePosition'),
    ts: `const closed = await client.closePosition('${POSITION}');`, py: `closed = client.close_position("${POSITION}")` },
  reducePosition: { recorded: true, params: { id: POSITION }, body: { fraction: '0.5' }, response: rec('reducePosition'),
    ts: `const reduced = await client.reducePosition('${POSITION}', { fraction: '0.5' });`, py: `reduced = client.reduce_position("${POSITION}", fraction="0.5")` },
  runCommand: { recorded: true, body: { text: 'LONG BTC-PERP 100', mode: 'paper', dryRun: true }, response: rec('runCommand'),
    ts: `const r = await client.runCommand('LONG BTC-PERP 100', { mode: 'paper', dryRun: true });\nif (r.kind === 'order' && !r.executed) console.log(r.order, r.hash);`,
    py: `r = client.run_command("LONG BTC-PERP 100", mode="paper", dry_run=True)`, note: 'A dry run: the canonical order the line resolves to, and nothing created. Needs the owner\'s command defaults (see Commands).' },

  // ------------------------------------------------------------------------------------------------------------ risk
  getRisk: { recorded: true, response: rec('getRisk'),
    ts: `const risk = await client.getRisk();\nif (risk.engine.killSwitch.on) console.log('no new risk until the owner releases it');`, py: `risk = client.get_risk()\nif risk.engine.kill_switch.on:\n    print("no new risk until the owner releases it")`,
    note: 'Cut to one lock and one account; the per-asset maps of the signer policy are cut to four entries.' },
  engageKillSwitch: { recorded: true, body: { reason: 'documentation example' }, response: rec('engageKillSwitch'),
    ts: `await client.engageKillSwitch('bot detected a runaway loop');`, py: `client.engage_kill_switch("bot detected a runaway loop")`, note: 'A key can engage it and can never release it.' },

  // ------------------------------------------------------------------------------------------------------------ strategies
  listStrategies: { recorded: true, query: { kind: 'perp' }, response: rec('listStrategies'),
    ts: `const { library, versions } = await client.listStrategies({ kind: 'perp' });`, py: `strategies = client.list_strategies(kind="perp")`, note: 'Cut to one library entry and one version.' },
  createStrategy: { recorded: true, body: { kind: 'perp', path: 'strategies/momentum_xs_perp/2', agentId: PERP_AGENT }, response: rec('createStrategy'),
    ts: `const { strategy } = await client.createStrategy({ kind: 'perp', path: 'strategies/momentum_xs_perp/2', agentId: '${PERP_AGENT}' });`,
    py: `strategy = client.create_strategy(kind="perp", path="strategies/momentum_xs_perp/2", agent_id="${PERP_AGENT}").strategy` },
  backtestStrategy: { recorded: true, params: { id: STRATEGY }, body: {}, response: rec('backtestStrategy'),
    ts: `const { job } = await client.backtestStrategy('${STRATEGY}');\nconst done = await client.waitForJob(job.id);`, py: `job = client.backtest_strategy("${STRATEGY}").job\ndone = client.wait_for_job(job.id)` },
  startStrategy: { recorded: true, params: { id: STRATEGY }, body: { mode: 'paper' }, response: rec('startStrategy'),
    ts: `await client.startStrategy('${STRATEGY}', { mode: 'paper' });`, py: `client.start_strategy("${STRATEGY}", mode="paper")`,
    note: 'Only the most recent version of an agent starts, and only once its backtest is done (409 `other_version`, `no_report` otherwise).' },
  stopStrategy: { recorded: true, params: { id: STRATEGY }, body: { reason: 'documentation example' }, response: rec('stopStrategy'),
    ts: `await client.stopStrategy('${STRATEGY}', { reason: 'documentation example' });`, py: `client.stop_strategy("${STRATEGY}", reason="documentation example")` },

  // ------------------------------------------------------------------------------------------------------------ agents
  listAgents: { recorded: true, response: rec('listAgents'), ts: `const { agents } = await client.listAgents();`, py: `agents = client.list_agents().agents` },
  listAgentTemplates: { recorded: true, response: rec('listAgentTemplates'), ts: `const { templates } = await client.listAgentTemplates();`, py: `templates = client.list_agent_templates().templates`, note: 'Cut to one of the seven templates.' },
  getAgent: { recorded: true, params: { id: AGENT }, response: rec('getAgent'), ts: `const { agent } = await client.getAgent('${AGENT}');`, py: `agent = client.get_agent("${AGENT}").agent` },
  listAgentSignals: { recorded: true, params: { id: AGENT }, query: { mode: 'paper', limit: 2 }, response: rec('listAgentSignals'),
    ts: `const { signals } = await client.listAgentSignals('${AGENT}', { mode: 'paper', limit: 2 });`, py: `signals = client.list_agent_signals("${AGENT}", mode="paper", limit=2).signals` },
  listAgentJournal: { recorded: true, params: { id: AGENT }, query: { mode: 'paper', limit: 3 }, response: rec('listAgentJournal'),
    ts: `const { entries } = await client.listAgentJournal('${AGENT}', { mode: 'paper', limit: 3 });`, py: `entries = client.list_agent_journal("${AGENT}", mode="paper", limit=3).entries` },
  listAgentOrders: { recorded: true, params: { id: AGENT }, query: { mode: 'paper', limit: 2 }, response: rec('listAgentOrders'),
    ts: `const { orders } = await client.listAgentOrders('${AGENT}', { mode: 'paper', limit: 2 });`, py: `orders = client.list_agent_orders("${AGENT}", mode="paper", limit=2).orders`, note: 'The recorded agent had placed no order yet.' },
  getAgentPerformance: { recorded: true, params: { id: AGENT }, query: { mode: 'paper' }, response: rec('getAgentPerformance'),
    ts: `const perf = await client.getAgentPerformance('${AGENT}', { mode: 'paper' });`, py: `perf = client.get_agent_performance("${AGENT}", mode="paper")`, note: 'A figure that cannot be computed is `{ value: null, reason }`, never zero.' },
  getJob: { recorded: true, params: { id: JOB }, response: rec('getJob'), ts: `const { job } = await client.getJob('${JOB}');`, py: `job = client.get_job("${JOB}").job` },
  createAgent: { recorded: true, body: { template: 'funding-arb', name: 'Docs funding', mode: 'research' }, response: rec('createAgent'),
    ts: `const { agent } = await client.createAgent({ template: 'funding-arb', name: 'Docs funding', mode: 'research' });`, py: `agent = client.create_agent(template="funding-arb", name="Docs funding", mode="research").agent` },
  startAgent: { recorded: true, params: { id: AGENT }, body: { mode: 'paper' }, response: rec('startAgent'), ts: `await client.startAgent('${AGENT}', { mode: 'paper' });`, py: `client.start_agent("${AGENT}", mode="paper")` },
  pauseAgent: { recorded: true, params: { id: AGENT }, body: { reason: 'documentation example' }, response: rec('pauseAgent'),
    ts: `await client.pauseAgent('${AGENT}', { reason: 'documentation example' });`, py: `client.pause_agent("${AGENT}", reason="documentation example")` },
  stopAgent: { recorded: true, params: { id: AGENT }, body: { reason: 'documentation example' }, response: rec('stopAgent'),
    ts: `await client.stopAgent('${AGENT}', { reason: 'documentation example' });`, py: `client.stop_agent("${AGENT}", reason="documentation example")` },
  backtestAgent: { recorded: true, params: { id: AGENT }, body: { hours: 1 }, response: rec('backtestAgent'),
    ts: `const { job } = await client.backtestAgent('${AGENT}', { hours: 1 });`, py: `job = client.backtest_agent("${AGENT}", hours=1).job` },
};

/** Recorded error answers, shown in the guide (the request that produced each one is described next to it). */
export const ERROR_EXAMPLES = {
  unauthenticated: { status: 401, body: { error: 'unauthenticated', message: 'authentication required' } },
  insufficientScope: { status: 403, body: rec('errInsufficientScope') },
  mandateRequired: { status: 403, body: rec('errMandateRequired') },
  mandateDenied: { status: 403, body: rec('errMandateDenied') },
  executionDisabled: { status: 403, body: rec('errExecutionDisabled') },
  killSwitch: { status: 423, body: rec('errKillSwitch') },
  priceDeviation: { status: 422, body: rec('errPriceDeviation') },
  ambiguousSymbol: { status: 409, body: rec('errAmbiguousSymbol') },
  ambiguousCommand: { status: 409, body: rec('errAmbiguousCommand') },
  parseError: { status: 400, body: rec('errParse') },
  idempotencyMissing: { status: 400, body: rec('errIdempotencyMissing') },
  idempotencyConflict: { status: 409, body: rec('errIdempotencyConflict') },
  rateLimited: { status: 429, body: rec('errRateLimited') },
  badRequest: { status: 400, body: rec('errBadRequest') },
  notFound: { status: 404, body: rec('errNotFound') },
} as const;
/** other recorded answers the guide quotes */
export const EXTRA = { previewRefused: rec('previewOrderRefused'), limitOrder: rec('placeLimitOrder'), cancelAgain: rec('cancelOrderAgain'), commandExecuted: rec('runCommandExecuted'), commandQuery: rec('runCommandQuery') };
