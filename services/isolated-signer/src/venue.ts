// Live derivatives on a venue (Hyperliquid): the signer side. Docs: docs/v4/DERIVATIVES-ARCHITECTURE.md ("Signing"), docs/v4/venues/hyperliquid.md.
//
// Two keys, two very different powers:
//   - the MAIN wallet key signs exactly one kind of venue message: Hyperliquid's `approveAgent`, naming the signer's own trading
//     key, once per authorization, and only after the owner's passkey approved the canonical authorization (venueAuthorize);
//   - the TRADING key (API wallet, path m/44'/60'/9000'/0/<i>) signs orders, cancels and leverage changes, only under a stored,
//     unrevoked, unexpired authorization, and only after this file has read the payload ITSELF (`describe`, pinned asset table).
// Nothing here can sign a transfer, a withdrawal, a sub-account or vault action, or an agent approval outside venueAuthorize.
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { sign } from 'viem/accounts';
import {
  createHlTrading, D, HL_KIND_L1, hex, hlPinnedAsset, hlPinnedAssets, jurisdictionAckOf, signatureFromHex, typedDataDigest, validateVenueAuthorization, venueAgentWireName,
  venueAuthorizationHash, VenueAuthorizationSchema, venueLeverageHash, VenueLeverageSchema, venueOrderHash, venueOrderNotional, VenueOrderSchema, venueWindowError, withinBand,
  type HlDescription, type HlL1SignPayload, type HlSignature, type HlUserSignPayload, type SignRequest, type VenueAuthorization,
} from '@spw/derivatives/live';
import type { Keys } from './keys.ts';
import type { PriceView } from './prices.ts';
import type { Store, StoredVenueAuthorization } from './store.ts';

/** what venue.ts needs from the Signer: its keys, its store, its clock (unix seconds), its own prices and its passkey verifier */
export interface VenueCtx {
  keys: Keys; store: Store; now: () => number; prices: PriceView;
  verify(assertion: AuthenticationResponseJSON, challenge: Uint8Array): Promise<unknown>;
  fail(code: string, msg: string): Error;
}
export interface VenueAuthorizeResult { authorizationId: string; hash: string; agentAddress: string; approve: StoredVenueAuthorization['approve'] }
export interface VenueSignRequest { authorizationId: string; sign: SignRequest; context?: { order?: unknown; leverage?: unknown }; assertion?: AuthenticationResponseJSON }
export interface VenueSignResult { signature: HlSignature; signer: string; kind: 'order' | 'cancel' | 'leverage'; hash: string }

/** nonces remembered per trading key, as the venue does */
export const VENUE_NONCE_SET = 100;
const day = (nowSec: number) => new Date(nowSec * 1000).toISOString().slice(0, 10);
const hexKey = (priv: Uint8Array) => `0x${Buffer.from(priv).toString('hex')}` as `0x${string}`;
const canon = (x: string) => D.str(D.from(x));

export function venueKeyAddress(ctx: VenueCtx, venue: unknown, network: unknown): { venue: 'hyperliquid'; network: 'mainnet' | 'testnet'; address: string; path: string; account: string } {
  if (venue !== 'hyperliquid' || (network !== 'mainnet' && network !== 'testnet')) throw ctx.fail('bad_request', 'unknown venue or network');
  const k = ctx.keys.venueKey(venue, network);
  return { venue, network, address: k.address, path: k.path, account: ctx.keys.addresses.evm.toLowerCase() };
}

export function venueStatus(ctx: VenueCtx) {
  const now = ctx.now(), today = day(now);
  return Object.values(ctx.store.state.venues ?? {}).map((r) => ({
    authorization: r.authorization, hash: r.hash, approvedAt: r.approvedAt, revoked: r.revoked, revokedAt: r.revokedAt ?? null, expired: now >= r.authorization.expiresAt,
    lastNonce: r.nonces[r.nonces.length - 1] ?? 0, today: r.usage[today] ?? { orders: 0, cancels: 0, leverage: 0 },
  }));
}

/**
 * The owner enables live trading on one venue account: passkey assertion over the canonical authorization. On success the
 * MAIN key signs the venue's approveAgent action for the signer's own trading key — the only venue message it ever signs.
 */
export async function venueAuthorize(ctx: VenueCtx, raw: unknown, assertion: AuthenticationResponseJSON | undefined): Promise<VenueAuthorizeResult> {
  const st = ctx.store, now = ctx.now();
  const parsed = VenueAuthorizationSchema.safeParse(raw);
  if (!parsed.success) throw ctx.fail('bad_request', 'malformed venue authorization');
  const a: VenueAuthorization = parsed.data, hash = venueAuthorizationHash(a), id = a.authorizationId;
  const deny = (code: string, msg: string): never => { st.log('venue.authorize.denied', { authorizationId: id, venue: a.venue, network: a.network, code, msg }); st.save(); throw ctx.fail(code, msg); };
  if (st.state.halted) deny('policy', 'emergency halt is active');
  if (a.keyId !== ctx.keys.keyId) deny('wrong_key', 'authorization targets another key');
  try { validateVenueAuthorization(a, now); } catch (e) { deny('unsupported', (e as Error).message); }
  if (a.account !== ctx.keys.addresses.evm.toLowerCase()) deny('wrong_source', 'the venue account is not this wallet\'s own address');
  const agent = ctx.keys.venueKey(a.venue, a.network);
  if (a.agentAddress !== agent.address) deny('wrong_agent', 'the trading address does not match this signer\'s derivation: only the signer\'s own trading key can be approved');
  if (st.state.venues?.[id]) deny('replay', 'authorization already recorded');
  for (const r of Object.values(st.state.venues ?? {})) {
    if (r.authorization.venue === a.venue && r.authorization.network === a.network && !r.revoked && now < r.authorization.expiresAt) deny('conflict', 'another authorization is active for this venue account: revoke it first');
  }
  for (const inst of a.policy.allowedInstruments) {
    const pinned = hlPinnedAsset(a.network, inst);
    if (!pinned) deny('unsupported', `${inst} is not in the signer's pinned ${a.network} asset table`);
    if (a.policy.maxLeverage > pinned!.maxLeverage) deny('unsupported', `leverage ${a.policy.maxLeverage} is above the venue maximum of ${inst} (${pinned!.maxLeverage})`);
  }
  if (!jurisdictionAckOf(a.venue, a.ackSha256)) deny('acknowledgement', 'the acknowledgement hash is not the hash of the jurisdiction summary this signer knows');

  // built here from the authorization alone; nothing from the API is signed
  const trading = createHlTrading({ network: a.network, assets: hlPinnedAssets(a.network) });
  let built: ReturnType<typeof trading.buildApproveAgent>;
  try { built = trading.buildApproveAgent({ agentAddress: a.agentAddress, agentName: venueAgentWireName(a), nonce: a.approveNonce }); }
  catch (e) { return deny('unsupported', (e as Error).message); }
  const d = trading.describe(built.sign);
  if (d.kind !== 'approve_agent' || d.detail.agentAddress !== agent.address || d.detail.validUntil !== a.expiresAt * 1000) deny('internal', 'approval action does not read back as expected');

  if (!assertion) deny('bad_approval', 'the owner\'s passkey approval is required');
  try { await ctx.verify(assertion!, hash); } catch (e) { deny((e as { code?: string }).code ?? 'bad_approval', (e as Error).message); }

  const signature = signatureFromHex(await sign({ hash: typedDataDigest((built.sign.payload as HlUserSignPayload).typedData), privateKey: hexKey(ctx.keys.evmPriv), to: 'hex' }));
  const rec: StoredVenueAuthorization = { authorization: a, hash: hex(hash), approvedAt: new Date(now * 1000).toISOString(), revoked: false,
    approve: { action: built.action, signature, nonce: a.approveNonce }, nonces: [], clientIds: {}, usage: {} };
  (st.state.venues ??= {})[id] = rec;
  st.log('venue.authorized', { authorizationId: id, hash: rec.hash, venue: a.venue, network: a.network, account: a.account, agentAddress: a.agentAddress, agentName: a.agentName, mode: a.mode,
    policy: a.policy, expiresAt: a.expiresAt, ackSha256: a.ackSha256 });
  st.save(); // durable before the signature leaves
  return { authorizationId: id, hash: rec.hash, agentAddress: agent.address, approve: rec.approve };
}

/** Stopping never needs a passkey. A revoked authorization signs nothing, ever again (the record is kept, so a restart changes nothing). */
export function venueRevoke(ctx: VenueCtx, authorizationId: string): { revoked: true; revokedAt: string } {
  const r = ctx.store.state.venues?.[authorizationId];
  if (!r) throw ctx.fail('not_found', 'unknown venue authorization');
  if (!r.revoked) {
    r.revoked = true; r.revokedAt = new Date(ctx.now() * 1000).toISOString();
    ctx.store.log('venue.revoked', { authorizationId, venue: r.authorization.venue, network: r.authorization.network });
    ctx.store.save();
  }
  return { revoked: true, revokedAt: r.revokedAt! };
}

/**
 * Sign ONE venue action with the trading key. The payload is read here, with the pinned asset table; what the API says it is
 * does not matter. MANUAL_LIVE: an order or a leverage change needs a passkey assertion over the hash of the canonical object
 * in `context`, which must equal, field by field, what the payload really does. A cancel needs no passkey.
 */
export async function venueSign(ctx: VenueCtx, req: VenueSignRequest): Promise<VenueSignResult> {
  const st = ctx.store, now = ctx.now(), nowMs = now * 1000;
  const id = String(req?.authorizationId ?? '');
  const rec = st.state.venues?.[id];
  if (!rec) throw ctx.fail('not_found', 'unknown venue authorization');
  const a = rec.authorization;
  const deny = (code: string, msg: string): never => { st.log('venue.sign.denied', { authorizationId: id, code, msg: msg.slice(0, 300) }); st.save(); throw ctx.fail(code, msg); };
  if (rec.revoked) deny('revoked', 'authorization revoked');
  if (now >= a.expiresAt) deny('expired', 'authorization expired');
  if (a.mode !== 'MANUAL_LIVE') deny('unsupported', 'only MANUAL_LIVE authorizations can sign');
  const s = req.sign;
  if (!s || typeof s !== 'object') deny('bad_request', 'missing sign request');
  if (s.venue !== a.venue || s.network !== a.network) deny('wrong_venue', 'the sign request is for another venue or network than the authorization');

  // 1. what does the payload do? (independent reading, pinned table)
  const trading = createHlTrading({ network: a.network, assets: hlPinnedAssets(a.network) });
  let d: HlDescription;
  try { d = trading.describe(s); } catch (e) { return deny('rejected', `payload refused: ${(e as Error).message}`); }
  if (d.kind === 'approve_agent') deny('unsupported', 'an agent approval can only be signed through /venue/authorize, by the main key, with the owner\'s passkey');
  if (d.kind === 'other' || s.kind !== HL_KIND_L1) deny('unsupported', `this payload is not an order, a cancel or a leverage change (${String(d.detail.type ?? d.detail.primaryType ?? s.kind).slice(0, 60)}): the trading key signs nothing else`);
  const p = d.detail as { nonce: number; vaultAddress: string | null; expiresAfter: number | null; connectionId: string };
  if (p.vaultAddress !== null) deny('unsupported', 'sub-accounts and vaults are not traded');
  if (p.expiresAfter === null) deny('policy', 'the action carries no venue expiry: a signature that never expires is not released');
  const win = venueWindowError({ nonce: p.nonce, expiresAt: p.expiresAfter! }, nowMs);
  if (win) deny(/expired/.test(win) ? 'expired' : /stale/.test(win) ? 'stale_nonce' : 'policy', win);
  // the venue's own rule, applied here first: "the 100 highest nonces are stored per address. Every new transaction must have
  // nonce larger than the smallest nonce in this set and also never have been used before" (nonces are per signer key)
  if (rec.nonces.includes(p.nonce)) deny('stale_nonce', 'nonce already used with this trading key');
  if (rec.nonces.length >= VENUE_NONCE_SET && p.nonce <= rec.nonces[0]!) deny('stale_nonce', 'nonce is below the lowest of the last nonces signed with this trading key');
  const allowed = (inst: string) => { if (!a.policy.allowedInstruments.includes(inst)) deny('policy', `${inst} is not allowed by the authorization`); };
  const today = day(now), usage = rec.usage[today] ?? { orders: 0, cancels: 0, leverage: 0 };
  let hash: string, summary: Record<string, unknown>;

  if (d.kind === 'cancel') {
    // no passkey, no halt check: withdrawing an order is always possible while the authorization lives
    const cancels = d.detail.cancels as { instrument: string; venueOrderId?: string; clientId?: string }[];
    for (const c of cancels) allowed(c.instrument);
    usage.cancels += cancels.length; hash = p.connectionId.slice(2);
    summary = { cancels: cancels.length, instruments: [...new Set(cancels.map((c) => c.instrument))] };
  } else if (d.kind === 'order') {
    if (st.state.halted) deny('policy', 'emergency halt is active');
    if (!d.orders || d.orders.length !== 1) deny('unsupported', 'exactly one order per signature');
    const o = d.orders![0]!;
    const cp = VenueOrderSchema.safeParse(req.context?.order);
    if (!cp.success) deny('bad_request', 'malformed order context');
    const c = cp.data!;
    const same: [string, boolean][] = [
      ['authorization', c.authorizationId === id && c.venue === a.venue && c.network === a.network && c.account === a.account],
      ['nonce', c.nonce === p.nonce], ['expiry', c.expiresAt === p.expiresAfter],
      ['instrument', c.instrument === o.instrument], ['side', c.side === o.side], ['type', c.type === o.type], ['size', canon(c.size) === o.size], ['price', o.price !== null && canon(c.price) === o.price],
      ['trigger price', (c.triggerPrice === null ? null : canon(c.triggerPrice)) === o.triggerPrice], ['reduce-only', c.reduceOnly === o.reduceOnly], ['time in force', c.tif === o.tif], ['client id', c.clientId === o.clientId],
    ];
    const diff = same.find(([, ok]) => !ok);
    if (diff) deny('mismatch', `the order shown for approval and the payload to sign differ (${diff[0]})`);
    allowed(c.instrument);
    const notional = venueOrderNotional(c);
    // the signer has no view of positions: reduce-only orders are bounded like the others
    if (D.gt(D.from(notional), D.from(a.policy.maxOrderNotional))) deny('policy', `order notional ${notional} is above the authorized ${a.policy.maxOrderNotional}`);
    if (usage.orders >= a.policy.maxOrdersPerDay) deny('policy', 'daily order count reached');
    if (rec.clientIds[c.clientId] !== undefined) deny('replay', 'an order with this client id was already signed');
    // the signer's own price: a compromised API cannot get a far-off-market order signed, even with a passkey approval of it
    const symbol = c.instrument.slice(c.instrument.indexOf(':') + 1);
    let mid: string;
    try { const px = (await ctx.prices.get([symbol]))[symbol]; if (!(typeof px === 'number' && px > 0 && Number.isFinite(px))) throw new Error('no price'); mid = canon(px.toFixed(8)); }
    catch (e) { return deny('no_price', `the signer could not establish its own market price for ${symbol} (${(e as Error).message.slice(0, 80)}); order refused`); }
    for (const [what, px] of [['price', c.price], ['trigger price', c.triggerPrice]] as const) {
      if (px !== null && !withinBand(px, mid, a.policy.maxPriceDeviationBps)) deny('price', `${what} ${canon(px)} is more than ${a.policy.maxPriceDeviationBps} bps away from the signer's own ${symbol} price ${mid}`);
    }
    if (!req.assertion) deny('bad_approval', 'MANUAL_LIVE: every order needs the owner\'s passkey approval');
    const oh = venueOrderHash(c);
    try { await ctx.verify(req.assertion!, oh); } catch (e) { deny((e as { code?: string }).code ?? 'bad_approval', (e as Error).message); }
    usage.orders += 1; rec.clientIds[c.clientId] = Math.floor(now / 86400); hash = hex(oh);
    summary = { instrument: c.instrument, side: c.side, type: c.type, size: canon(c.size), price: canon(c.price), triggerPrice: c.triggerPrice, reduceOnly: c.reduceOnly, tif: c.tif, clientId: c.clientId, notional, mid };
  } else {
    if (st.state.halted) deny('policy', 'emergency halt is active');
    const lp = VenueLeverageSchema.safeParse(req.context?.leverage);
    if (!lp.success) deny('bad_request', 'malformed leverage context');
    const l = lp.data!, x = d.detail as { instrument: string; leverage: string; marginMode: string };
    if (l.authorizationId !== id || l.venue !== a.venue || l.network !== a.network || l.account !== a.account || l.nonce !== p.nonce || l.expiresAt !== p.expiresAfter
      || l.instrument !== x.instrument || String(l.leverage) !== x.leverage || l.marginMode !== x.marginMode) deny('mismatch', 'the leverage change shown for approval and the payload to sign differ');
    allowed(l.instrument);
    if (l.leverage > a.policy.maxLeverage) deny('policy', `leverage ${l.leverage} is above the authorized ${a.policy.maxLeverage}`);
    if (!req.assertion) deny('bad_approval', 'MANUAL_LIVE: a leverage change needs the owner\'s passkey approval');
    const lh = venueLeverageHash(l);
    try { await ctx.verify(req.assertion!, lh); } catch (e) { deny((e as { code?: string }).code ?? 'bad_approval', (e as Error).message); }
    usage.leverage += 1; hash = hex(lh);
    summary = { instrument: l.instrument, leverage: l.leverage, marginMode: l.marginMode };
  }

  // counters, replay marker and nonce are durable BEFORE the signature leaves
  rec.nonces = [...rec.nonces, p.nonce].sort((x, y) => x - y).slice(-VENUE_NONCE_SET); rec.usage[today] = usage;
  st.prune(now);
  const agent = ctx.keys.venueKey(a.venue, a.network);
  const signature = signatureFromHex(await sign({ hash: typedDataDigest((s.payload as HlL1SignPayload).typedData), privateKey: hexKey(agent.priv), to: 'hex' }));
  st.log('venue.sign.ok', { authorizationId: id, kind: d.kind, nonce: p.nonce, expiresAfter: p.expiresAfter, connectionId: p.connectionId, hash, ...summary });
  st.save();
  return { signature, signer: agent.address, kind: d.kind as VenueSignResult['kind'], hash };
}
