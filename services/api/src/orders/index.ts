// V11 execution — wiring for the rest of the API service: the risk service, the trading mandates and the order service on the
// SAME engine instances the server's routes use, the hooks that put the unified risk engine and the kill switch in front of
// every engine path, the `order.updated` webhooks, the supervisor loop, and the owner's routes (/api/v1/risk, /api/v1/mandates).
//
// Nothing here is under /api/v1/trading: an API key is refused on every route of this file by the gate of server.ts
// (`key_path_forbidden`), whatever its scopes.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listCreds, verifyOwnerAssertion } from '../auth.ts';
import { capabilities } from '../capabilities.ts';
import { config, UserError } from '../config.ts';
import { derivatives, type Derivatives } from '../derivatives/index.ts';
import type { LiveService } from '../derivatives/exec.ts';
import type { GmxService } from '../derivatives/gmx-exec.ts';
import { live } from '../derivatives/live.ts';
import { MandateService } from '../mandates/service.ts';
import { verifyStoredAssertion } from '../risk/passkey.ts';
import { RiskService, type BookKey } from '../risk/service.ts';
import { signer as signerClient, signerGuards } from '../signer-client.ts';
import type { QuotingSignerPort } from '../mm/quoting-mandate.ts';
import type { MmLocks, QuotingSignerPort as QuotingSignPort } from '../mm/live-adapter.ts';
import type { SignerQuotingView } from '../mm/runtime.ts';
import { emitWebhook } from '../trading-api/webhooks.ts';
import { loop } from '../worker.ts';
import { getSetting } from '../db.ts';
import { agentControl, type AgentControlPort } from './agent-control.ts';
import { OrderService } from './service.ts';
import { injectSpotPort, type SpotPort } from './spot.ts';
import { onTransition } from './store.ts';

export { OrderService, OWNER_CALLER, type Caller, type OrderInput } from './service.ts';
/** the signer's quoting endpoints (market making): approval and revocation for the mandate service, signatures and the status for the sessions */
export type QuotingSigner = QuotingSignerPort & QuotingSignPort & { status(fresh?: boolean): Promise<{ halted: boolean; venueQuotingMandates?: (SignerQuotingView & { mandate: { mandateId: string; authorizationId: string; account: string; network: string }; hash: string; revoked: boolean })[] }> };
export interface Execution { risk: RiskService; mandates: MandateService; orders: OrderService; /** STOP ALL AGENTS (orders/agent-control.ts) */ agents: AgentControlPort; /** V11 market making */ quotingSigner: QuotingSigner; live: () => LiveService }
declare module 'fastify' { interface FastifyInstance { execution: Execution } }
export interface ExecutionOpts {
  derivatives?: Derivatives | undefined; live?: LiveService | undefined; gmx?: GmxService | undefined;
  prices?: () => Promise<Record<string, { usd: number; priceAt?: string | null; source?: string }> | null>;
  /** tests: a verifier for the passkey steps of the API itself (limits, switches); default: auth.ts against the credentials table */
  verifyOwner?: (assertion: unknown, challenge: Uint8Array) => Promise<void>;
  /** tests: the re-verification of an approval stored with a live mandate; default: risk/passkey.ts against the credentials table */
  reverifyOwner?: (assertion: unknown, challenge: Uint8Array) => Promise<void>;
  signerStatus?: () => Promise<{ halted: boolean }>;
  /** V11 market making — tests: the signer's quoting endpoints (an in-process signer) and the quoting locks; default: the signer client and the process environment */
  quotingSigner?: QuotingSigner | undefined; mmLocks?: (() => MmLocks) | undefined;
  /** tests: the swap proposal flow behind an owner's spot order; default: the routes of this server, called in process (orders/spot.ts) */
  spot?: SpotPort | undefined;
  /** tests: the agents runtime behind STOP ALL AGENTS; default: the functions agents/ exports (orders/agent-control.ts) */
  agents?: AgentControlPort | undefined;
}
/** server setting, read at every use: anything but the exact value `on` keeps live execution through the trading API closed */
export const tradingApiExecutionEnabled = (): boolean => process.env.SPW_TRADING_API_EXECUTION === 'on';
export const SUPERVISOR_STEP_MS = 5_000;

export function createExecution(o: ExecutionOpts = {}): Execution {
  const d = (): Derivatives => o.derivatives ?? derivatives(), l = (): LiveService => o.live ?? live(), now = (): number => d().data.now();
  const gmx = (): Pick<GmxService, 'status'> => o.gmx ?? { status: async (locale) => (await import('../derivatives/gmx-live.ts')).gmx().status(locale) };
  // the signer the live engine itself talks to (in production the one signer client; a test's in-process signer otherwise)
  const signerStatus = o.signerStatus ?? (() => l().deps.signer.status());
  const risk = new RiskService({ now, rpId: config.rpId, credentials: async () => (await listCreds()).map((c) => ({ id: c.id, transports: c.transports })), verifyOwner: o.verifyOwner ?? verifyOwnerAssertion,
    derivatives: d, live: l, gmx, signerStatus, ...(o.prices ? { prices: o.prices } : {}),
    emit: (event, data) => emitWebhook(event, data) });
  // the order service and the mandates need each other (wind-down cancels what rests): the mandate service gets the cancel late
  const verifyOwner = o.verifyOwner ?? verifyOwnerAssertion;
  const mdeps: ConstructorParameters<typeof MandateService>[0] = { now, derivatives: d, live: l, signerStatus,
    passkey: { now, rpId: config.rpId, credentials: async () => (await listCreds()).map((c) => ({ id: c.id, transports: c.transports })), verifyOwner },
    reverify: o.reverifyOwner ?? ((assertion, challenge) => verifyStoredAssertion(assertion, challenge, { rpId: config.rpId, origin: config.origin })),
    quotingSigner: o.quotingSigner ?? (signerClient as unknown as QuotingSigner), ...(o.mmLocks ? { mmLocks: o.mmLocks } : {}) };
  const mandates = new MandateService(mdeps);
  const orders = new OrderService({ now, derivatives: d, live: l, risk, mandates, executionEnabled: tradingApiExecutionEnabled,
    gmx: async () => o.gmx ?? (await import('../derivatives/gmx-live.ts')).gmx() });
  mdeps.cancelResting = (id) => orders.cancelResting(id);
  // spot: the owner's command defaults settle the network and the quote asset of a spot order (the same record as trading-api/commands.ts)
  orders.deps.spot = o.spot ?? null;
  orders.deps.spotDefaults = async () => { const v = await getSetting<{ spotNetwork?: string; spotQuote?: string; maxSlippageBps?: number }>('trading.command_defaults', {}); return { spotNetwork: v.spotNetwork, spotQuote: v.spotQuote, maxSlippageBps: v.maxSlippageBps }; };
  return { risk, mandates, orders, agents: o.agents ?? agentControl(), quotingSigner: mdeps.quotingSigner as QuotingSigner, live: l };
}

/** puts the unified risk engine and the kill switch in front of every engine path, for the instances this server uses */
export function installGates(ex: Execution, o: ExecutionOpts): void {
  const d = o.derivatives ?? derivatives(), l = o.live ?? live();
  d.paper.preTrade = ex.risk.gate;
  l.preTrade = ex.risk.gate; l.newRiskBlock = ex.risk.newRiskBlock;
  const hookGmx = (g: GmxService): void => { g.preTrade = ex.risk.gate; g.newRiskBlock = ex.risk.newRiskBlock; };
  if (o.gmx) hookGmx(o.gmx); else void import('../derivatives/gmx-live.ts').then((m) => hookGmx(m.gmx())).catch((e: Error) => console.error(`[orders] GMX gate not installed: ${e.message}`));
  // spot agents: the API asks the signer for a swap under a vault mandate only while new risk is allowed
  signerGuards.beforeMandateSign = async (g) => { const b = await ex.risk.newRiskBlock(); if (b && !(b.code === 'kill_switch_active' && g?.reducesRisk === true)) throw new UserError(b.code, b.reason, 423); };   // the kill switch never blocks a reduction: a sale into the agent's cash leg is still signed (read-only mode blocks it)
}

const Assertion = z.strictObject({ assertion: z.record(z.string(), z.unknown()).optional() });
const Reason = z.strictObject({ reason: z.string().trim().max(200).default('') });
const ModeParam = z.object({ mode: z.enum(['paper', 'live']) });
const IdParam = z.object({ id: z.uuid() });
const P = '/api/v1/risk', M = '/api/v1/mandates';
const OWNER_ACTOR = { kind: 'owner' as const, id: 'owner' };
/** the owner's session only (server.ts sets `principal`); an API key never reaches these paths, and is refused here again if it did */
const ownerOnly = (req: FastifyRequest): void => { if (req.principal?.kind !== 'owner') throw new UserError('owner_only', 'this route is for the owner\'s session', 403); };

export function executionRoutes(app: FastifyInstance, ex: Execution): void {
  const { risk, mandates } = ex;
  app.addHook('preHandler', async (req) => { const p = req.url.split('?')[0]!; if (p.startsWith(`${P}/`) || p === P || p.startsWith(`${M}/`) || p === M) ownerOnly(req); });

  const exposure = async (book: BookKey) => risk.exposure(book).catch((e: unknown) => ({ book, error: (e as Error).message.slice(0, 200) }));
  app.get(`${P}/state`, async () => ({
    switches: await risk.switches(), auto: await risk.autoKill(), limits: { paper: await risk.limits('paper'), live: await risk.limits('live') },
    exposure: { paper: await exposure('paper'), live: await exposure('live-mainnet'), liveTestnet: await exposure('live-testnet') },
    decisions: await risk.decisions(30),
    locks: [...capabilities().filter((c) => ['deriv_live_mainnet', 'deriv_mandate_mainnet', 'deriv_gmx_live', 'deriv_mm_mainnet', 'deriv_mm_testnet'].includes(c.id)).map((c) => ({ id: c.id, on: c.on, why: c.why })),
      { id: 'trading_api_execution', on: tradingApiExecutionEnabled(), why: tradingApiExecutionEnabled() ? 'live orders can be placed through the trading API (inside a mandate, or with the owner\'s passkey)'
        : 'SPW_TRADING_API_EXECUTION is not "on": no NEW live risk is placed through the trading API; cancels and strictly reducing orders still pass; paper works' }],
    ts: risk.now(),
  }));
  app.get(`${P}/decisions`, async (req) => ({ decisions: await risk.decisions(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query).limit) }));
  app.get(`${P}/exposure`, async (req) => exposure(z.object({ book: z.enum(['paper', 'live-mainnet', 'live-testnet']).default('paper') }).parse(req.query).book));
  // kill switch and read-only mode: engaging is free, releasing needs the passkey (prepare → release)
  app.post(`${P}/kill-switch`, async (req) => risk.engageKillSwitch(OWNER_ACTOR, Reason.parse(req.body ?? {}).reason));
  app.post(`${P}/kill-switch/release/prepare`, async () => risk.prepareRelease('kill_switch'));
  app.post(`${P}/kill-switch/release`, async (req) => risk.release('kill_switch', Assertion.parse(req.body ?? {}).assertion));
  app.post(`${P}/read-only`, async (req) => risk.engageReadOnly(OWNER_ACTOR, Reason.parse(req.body ?? {}).reason));
  app.post(`${P}/read-only/release/prepare`, async () => risk.prepareRelease('read_only'));
  app.post(`${P}/read-only/release`, async (req) => risk.release('read_only', Assertion.parse(req.body ?? {}).assertion));
  // limits: tightening is free; loosening needs the passkey over the whole new limit set (prepare → approve)
  app.get(`${P}/limits/:mode`, async (req) => risk.limits(ModeParam.parse(req.params).mode));
  app.post(`${P}/limits/:mode`, async (req) => risk.setLimits(ModeParam.parse(req.params).mode, (req.body as { limits?: unknown } | undefined)?.limits));
  app.post(`${P}/limits/:mode/prepare`, async (req) => risk.prepareLimits(ModeParam.parse(req.params).mode, (req.body as { limits?: unknown } | undefined)?.limits));
  app.post(`${P}/limits/:mode/approve`, async (req) => risk.approveLimits(ModeParam.parse(req.params).mode, Assertion.parse(req.body ?? {}).assertion));
  app.post(`${P}/auto/prepare`, async (req) => risk.prepareAutoKill((req.body as { auto?: unknown } | undefined)?.auto));
  app.post(`${P}/auto`, async (req) => { const b = z.strictObject({ auto: z.unknown(), assertion: z.record(z.string(), z.unknown()).optional() }).parse(req.body); return { auto: await risk.setAutoKill(b.auto, b.assertion) }; });

  // trading mandates: created, approved and revoked by the owner only
  app.get(M, async () => ({ mandates: await mandates.list() }));
  app.post(M, async (req) => ({ mandate: await mandates.create(req.body) }));
  app.get(`${M}/:id`, async (req) => ({ mandate: await mandates.get(IdParam.parse(req.params).id) }));
  app.post(`${M}/:id/approve/prepare`, async (req) => mandates.prepareApproval(IdParam.parse(req.params).id, z.strictObject({ locale: z.enum(['fr', 'en']).default('en') }).parse(req.body ?? {}).locale));
  app.post(`${M}/:id/approve`, async (req) => ({ mandate: await mandates.approve(IdParam.parse(req.params).id, z.strictObject({ assertion: z.record(z.string(), z.unknown()).optional(), bindingAssertion: z.record(z.string(), z.unknown()).optional(), acknowledged: z.boolean().optional() }).parse(req.body ?? {})) }));
  // V11 market making: a lost answer of a quoting approval, and quoting mandates the signer holds that no record accounts for
  app.post(`${M}/recover-quoting`, async () => mandates.recoverQuoting());
  app.post(`${M}/:id/revoke`, async (req) => {
    const b = z.strictObject({ cancelOpenOrders: z.boolean().default(true), detail: z.string().max(300).optional() }).parse(req.body ?? {});
    return mandates.revoke(IdParam.parse(req.params).id, { by: 'owner', reason: 'owner_request', detail: b.detail ?? null, cancelOpenOrders: b.cancelOpenOrders });
  });
}

/** one call from server.ts: services, gates, webhooks, routes and (with workers on) the supervisor loop */
export function registerExecution(app: FastifyInstance, o: ExecutionOpts = {}): Execution {
  const ex = createExecution(o);
  // an owner's spot order is a swap proposal of this server's own swap flow, called in process with the owner's session
  if (!o.spot) ex.orders.deps.spot = injectSpotPort(app);
  installGates(ex, o);
  // the other workstreams (the agents runtime) and the tests reach the services of THIS server instance through the app
  app.decorate('execution', ex);
  // one-time migration, before the first request is served: the owner's live limits are seeded from what he had approved before V11
  app.addHook('onReady', async () => { await ex.risk.seedLiveLimits().catch((e: Error) => console.error(`[risk] the live limits could not be seeded from the venue accounts: ${e.message}`)); });
  // a fill or a cancel changes what the next evaluation must see: the shared venue reads of that book are dropped at once
  const offCache = onTransition((row, e) => { if (row.mode === 'live' && (e.to === 'FILLED' || e.to === 'PARTIALLY_FILLED' || e.to === 'CANCELLED' || e.event === 'reconciled_found')) ex.risk.invalidate(row.network === 'testnet' ? 'live-testnet' : 'live-mainnet'); });
  app.addHook('onClose', async () => { offCache(); });
  const off = onTransition(async (row, e) => { await emitWebhook('order.updated', { orderId: row.id, mode: row.mode, venue: row.venue, instrument: row.instrument, status: e.to, previous: e.from, event: e.event, reason: e.reason, seq: e.seq,
    principal: `${row.principal_kind}:${row.principal_id}`, mandateId: row.mandate_id }); });
  app.addHook('onClose', async () => { off(); });
  executionRoutes(app, ex);
  if (config.workers) {
    let last = '';
    loop('orders', async () => {
      const r = await ex.orders.reconcile(), m = await ex.mandates.supervise(), k = await ex.risk.superviseAuto();
      const line = `${r.unknown} unknown, ${r.resolved} resolved, ${r.orphans} orphan(s), ${m.stopped.length} mandate(s) stopped${k ? `, kill switch: ${k}` : ''}`;
      if ((r.unknown || r.orphans || m.stopped.length || k) && line !== last) console.log(`[orders] ${line}`);
      last = line;
    }, SUPERVISOR_STEP_MS);
  }
  return ex;
}
