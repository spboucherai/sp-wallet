import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Mandate, Policy } from '@spw/core';
import { config, UserError } from './config.ts';

export interface SignerStatus {
  keyId: string; addresses: Record<string, string>; halted: boolean; enrollmentOpen: boolean;
  credentials: { id: string; addedAt: string }[]; policy: Policy; spentToday: Record<string, string>; journalHead: string | null; journalLength: number;
  mandates?: { mandate: Mandate; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; today: { sold: Record<string, string>; orders: number } }[];
  venueMandates?: { mandate: { mandateId: string; authorizationId: string }; hash: string; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; phase: 'active' | 'wind_down' | 'ended'; windDownUntil: number | null;
    today: { orders: number; reduceOnly: number; cancels: number; leverage: number; turnover: string }; ordersLastHour: number; pendingOrders: number }[];
  /** V11 market making: the quoting mandates the signer holds, with what it would still sign and the state of the dead man's switch as IT recorded it */
  venueQuotingMandates?: SignerQuotingMandate[];
  /** v8: GMX venue policies stored by the signer */
  gmx?: import('./derivatives/gmx-exec.ts').GmxSignerAuth[];
  /** NFT delivery 2: the effective NFT policy (file + defaults), today's count, the allow-list; the locked outpoints per Bitcoin-style network. Absent from an older signer. */
  nft?: { policy: import('@spw/core').NftPolicy; signedToday: number; allow: { network: string; address: string; approvedAt: number }[] };
  utxoLocks?: Record<string, { outpoint: string; reason: 'owner' | 'ord' | 'heuristic'; at: number }[]>;
  venues?: { authorization: { authorizationId: string; venue: string; network: string }; hash: string; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; today: { orders: number; cancels: number; leverage: number } }[];
}

export interface SignerQuotingMandate { mandate: import('@spw/derivatives/live').VenueQuotingMandate; hash: string; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; phase: 'active' | 'wind_down' | 'ended'; windDownUntil: number | null;
  today: { quotes: number; batches: number; reduceOnly: number; cancels: number; heartbeats: number; turnover: string; lapses: number }; quotesThisHour: number; bucketActions: number; deadMan: { armed: boolean; deadline: number | null }; pendingQuotes: number }
interface SolTxParams { recentBlockhash: string; lastValidBlockHeight: number; computeUnitLimit: number; computeUnitPrice: string }
async function call<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000), nonce = randomUUID();
  const mac = createHmac('sha256', config.signerSecret).update([method, path, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  let r: Response;
  try {
    // one connection per request: never reuse an idle keep-alive socket the signer may have closed
    r = await fetch(config.signerUrl + path, { method, headers: { 'x-spw-auth': `t=${ts},n=${nonce},s=${mac}`, 'content-type': 'application/json', connection: 'close' }, body: body || undefined, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    console.error(`[signer-client] ${method} ${path} failed: ${err.name} ${err.message} ${err.cause?.code ?? ''} ${err.cause?.message ?? ''}`);
    throw new UserError('signer_unreachable', 'the signer is unreachable; nothing was signed', 503);
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!r.ok) throw new UserError(`signer_${j.error ?? 'error'}`, j.message ?? 'signer refused', r.status === 401 ? 502 : 422);
  return j as T;
}

/**
 * V11: checks the API makes before it asks the signer for a signature on behalf of a SPOT AGENT (`/mandate/sign`). The risk service
 * sets `beforeMandateSign` (orders/index.ts): with the global kill switch or read-only mode on it throws, and the signer is not
 * asked. Returns to the owner (`vaultReturn`, `mandateReturn`) and every passkey-approved action of the owner never pass here.
 */
export const signerGuards: { beforeMandateSign: ((o?: { /** the swap sells into the agent's cash leg: it adds no risk (said by agents/live.ts from the planned order) */ reducesRisk?: boolean }) => Promise<void>) | null } = { beforeMandateSign: null };

let cached: { at: number; v: SignerStatus } | null = null;
export const signer = {
  async status(fresh = false): Promise<SignerStatus> {
    if (!fresh && cached && Date.now() - cached.at < 5000) return cached.v;
    const v = await call<SignerStatus>('GET', '/status');
    cached = { at: Date.now(), v };
    return v;
  },
  enroll: (p: unknown) => { cached = null; return call<{ ok: true }>('POST', '/enroll', p); },
  sign: (intent: unknown, assertion: unknown, aux?: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string; pre?: { raw: string; txid: string }; eventAccount?: string }>('POST', '/sign', { intent, assertion, ...(aux ? { aux } : {}) }); },
  bridgeMint: (p: { proposalId: string; message: string; attestation: string; evm?: { nonce: number; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }; /** v8: a mint on Solana */ sol?: SolTxParams; assertion?: unknown }) => {
    cached = null; return call<{ raw: string; txid: string; messageHash: string; minted: string; replayed: boolean }>('POST', '/bridge/mint', p); },
  // v8 (Solana ↔ EVM): reclaim of the event-account deposit of a burn made on Solana, and the wallet's own USDC token account — passkey each
  bridgeReclaim: (p: { proposalId: string; message: string; attestation: string; sol: SolTxParams; assertion: unknown }) => { cached = null; return call<{ raw: string; txid: string; eventAccount: string }>('POST', '/bridge/reclaim', p); },
  solTokenAccount: (request: unknown, assertion: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string; tokenAccount: string }>('POST', '/sol/token-account', { request, assertion }); },
  halt: () => { cached = null; return call<{ ok: true }>('POST', '/halt', {}); },
  // NFT delivery 2 — passkey each: one NFT transfer (built by the signer from the intent), the outpoint lock list, the NFT allow-list
  nftSign: (intent: unknown, assertion: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string }>('POST', '/nft/sign', { intent, assertion }); },
  utxoLocks: (request: unknown, assertion: unknown) => { cached = null; return call<{ network: string; action: string; changed: number; locked: number; hash: string }>('POST', '/utxo/locks', { request, assertion }); },
  nftAllow: (request: unknown, assertion: unknown) => { cached = null; return call<{ network: string; address: string; action: string; entries: number; hash: string }>('POST', '/nft/allow', { request, assertion }); },
  // agent vaults and mandates
  vaultAddress: (index: number) => call<{ address: string }>('POST', '/vault/address', { index }),
  mandateApprove: (mandate: unknown, assertion: unknown) => { cached = null; return call<{ mandateId: string; hash: string }>('POST', '/mandate/approve', { mandate, assertion }); },
  mandateRevoke: (mandateId: string) => { cached = null; return call<{ ok: true }>('POST', '/mandate/revoke', { mandateId }); },
  mandateSign: async (mandateId: string, intent: unknown, aux?: unknown, guard?: { reducesRisk?: boolean }) => { await signerGuards.beforeMandateSign?.(guard); cached = null; return call<{ raw: string; txid: string; hash: string; pre?: { raw: string; txid: string } }>('POST', '/mandate/sign', { mandateId, intent, ...(aux ? { aux } : {}) }); },
  vaultReturn: (index: number, intent: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string }>('POST', '/vault/return', { index, intent }); },
  mandateReturn: (mandateId: string, intent: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string }>('POST', '/mandate/return', { mandateId, intent }); },  // live derivatives: venue trading key, authorization (passkey), one signature per venue action, revocation
  venueKey: (venue: string, network: string) => call<{ venue: string; network: string; address: string; path: string; account: string }>('POST', '/venue/key', { venue, network }),
  venueAuthorize: (authorization: unknown, assertion: unknown) => { cached = null; return call<{ authorizationId: string; hash: string; agentAddress: string; approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number } }>('POST', '/venue/authorize', { authorization, assertion }); },
  venueSign: (p: { authorizationId: string; sign: unknown; context?: unknown; assertion?: unknown }) => { cached = null; return call<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string }>('POST', '/venue/sign', p); },
  venueRevoke: (authorizationId: string) => { cached = null; return call<{ revoked: true; revokedAt: string }>('POST', '/venue/revoke', { authorizationId }); },
  // V11: the stored answer of an active authorization, again (its first answer was lost); nothing is signed
  venueAuthorization: (authorizationId: string) => call<{ authorizationId: string; hash: string; agentAddress: string; approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number } }>('POST', '/venue/authorization', { authorizationId }),
  // collateral: withdraw3 to the wallet's own address, signed by the main key after the passkey approved the canonical withdrawal
  venueWithdraw: (withdrawal: unknown, assertion: unknown) => { cached = null; return call<{ withdrawalId: string; hash: string; action: unknown; signature: { r: string; s: string; v: number }; nonce: number; signer: string }>('POST', '/venue/withdraw', { withdrawal, assertion }); },
  // derivative mandates: approval (passkey), one signature per venue action WITHOUT a passkey inside the limits the signer enforces, revocation
  venueMandateApprove: (mandate: unknown, assertion: unknown) => { cached = null; return call<{ mandateId: string; hash: string; authorizationId: string }>('POST', '/venue/mandate/approve', { mandate, assertion }); },
  venueMandateSign: (p: { mandateId: string; sign: unknown; context?: unknown }) => { cached = null; return call<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string; mandateId: string; phase: string }>('POST', '/venue/mandate/sign', p); },
  // v8 GMX v2: the venue policy (passkey) and its revocation; orders go through `sign` with an intent carrying a `gmx` section
  gmxAuthorize: (authorization: unknown, assertion: unknown) => { cached = null; return call<{ authorizationId: string; hash: string }>('POST', '/venue/gmx/authorize', { authorization, assertion }); },
  gmxRevoke: (authorizationId: string) => { cached = null; return call<{ revoked: true; revokedAt: string }>('POST', '/venue/gmx/revoke', { authorizationId }); },
  // V11 quoting mandates (market making): approval with the passkey; then batches of post-only quotes, reduce-only orders, cancels and the
  // venue's scheduleCancel are signed WITHOUT a passkey inside the limits the signer enforces; revocation never needs a passkey.
  // A lost answer of the approval is recovered from `status().venueQuotingMandates` (mandates/service.ts `recoverQuoting`): the signer
  // either holds the mandate with the expected hash (adopted) or it does not (the approval is asked again, or the orphan is revoked).
  venueQuotingApprove: (mandate: unknown, assertion: unknown) => { cached = null; return call<{ mandateId: string; hash: string; authorizationId: string }>('POST', '/venue/quoting/approve', { mandate, assertion }); },
  venueQuotingSign: (p: { mandateId: string; sign: unknown }) => { cached = null; return call<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string; mandateId: string; phase: string; orders: number }>('POST', '/venue/quoting/sign', p); },
  venueQuotingRevoke: (mandateId: string) => { cached = null; return call<{ revoked: true; revokedAt: string; windDownUntil: number }>('POST', '/venue/quoting/revoke', { mandateId }); },
  venueMandateRevoke: (mandateId: string) => { cached = null; return call<{ revoked: true; revokedAt: string; windDownUntil: number }>('POST', '/venue/mandate/revoke', { mandateId }); },
};

/** The wallet's address on a network; fails closed when the signer has no key for it. */
export function addressFor(st: SignerStatus, network: string): string {
  const a = st.addresses[network];
  if (!a) throw new UserError('unsupported_network', 'the signer has no key for this network yet', 503);
  return a;
}
