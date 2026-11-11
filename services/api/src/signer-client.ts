import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Mandate, Policy } from '@spw/core';
import { config, UserError } from './config.ts';

export interface SignerStatus {
  keyId: string; addresses: Record<string, string>; halted: boolean; enrollmentOpen: boolean;
  credentials: { id: string; addedAt: string }[]; policy: Policy; spentToday: Record<string, string>; journalHead: string | null; journalLength: number;
  mandates?: { mandate: Mandate; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; today: { sold: Record<string, string>; orders: number } }[];
  venueMandates?: { mandate: { mandateId: string; authorizationId: string }; hash: string; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; phase: 'active' | 'wind_down' | 'ended'; windDownUntil: number | null;
    today: { orders: number; reduceOnly: number; cancels: number; leverage: number; turnover: string }; ordersLastHour: number; pendingOrders: number }[];
  /** v8: GMX venue policies stored by the signer */
  gmx?: import('./derivatives/gmx-exec.ts').GmxSignerAuth[];
  venues?: { authorization: { authorizationId: string; venue: string; network: string }; hash: string; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; today: { orders: number; cancels: number; leverage: number } }[];
}

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

let cached: { at: number; v: SignerStatus } | null = null;
export const signer = {
  async status(fresh = false): Promise<SignerStatus> {
    if (!fresh && cached && Date.now() - cached.at < 5000) return cached.v;
    const v = await call<SignerStatus>('GET', '/status');
    cached = { at: Date.now(), v };
    return v;
  },
  enroll: (p: unknown) => { cached = null; return call<{ ok: true }>('POST', '/enroll', p); },
  sign: (intent: unknown, assertion: unknown, aux?: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string; pre?: { raw: string; txid: string } }>('POST', '/sign', { intent, assertion, ...(aux ? { aux } : {}) }); },
  bridgeMint: (p: { proposalId: string; message: string; attestation: string; evm: { nonce: number; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }; assertion?: unknown }) => {
    cached = null; return call<{ raw: string; txid: string; messageHash: string; minted: string; replayed: boolean }>('POST', '/bridge/mint', p); },
  halt: () => { cached = null; return call<{ ok: true }>('POST', '/halt', {}); },
  // agent vaults and mandates
  vaultAddress: (index: number) => call<{ address: string }>('POST', '/vault/address', { index }),
  mandateApprove: (mandate: unknown, assertion: unknown) => { cached = null; return call<{ mandateId: string; hash: string }>('POST', '/mandate/approve', { mandate, assertion }); },
  mandateRevoke: (mandateId: string) => { cached = null; return call<{ ok: true }>('POST', '/mandate/revoke', { mandateId }); },
  mandateSign: (mandateId: string, intent: unknown, aux?: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string; pre?: { raw: string; txid: string } }>('POST', '/mandate/sign', { mandateId, intent, ...(aux ? { aux } : {}) }); },
  vaultReturn: (index: number, intent: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string }>('POST', '/vault/return', { index, intent }); },
  mandateReturn: (mandateId: string, intent: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string }>('POST', '/mandate/return', { mandateId, intent }); },  // live derivatives: venue trading key, authorization (passkey), one signature per venue action, revocation
  venueKey: (venue: string, network: string) => call<{ venue: string; network: string; address: string; path: string; account: string }>('POST', '/venue/key', { venue, network }),
  venueAuthorize: (authorization: unknown, assertion: unknown) => { cached = null; return call<{ authorizationId: string; hash: string; agentAddress: string; approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number } }>('POST', '/venue/authorize', { authorization, assertion }); },
  venueSign: (p: { authorizationId: string; sign: unknown; context?: unknown; assertion?: unknown }) => { cached = null; return call<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string }>('POST', '/venue/sign', p); },
  venueRevoke: (authorizationId: string) => { cached = null; return call<{ revoked: true; revokedAt: string }>('POST', '/venue/revoke', { authorizationId }); },
  // collateral: withdraw3 to the wallet's own address, signed by the main key after the passkey approved the canonical withdrawal
  venueWithdraw: (withdrawal: unknown, assertion: unknown) => { cached = null; return call<{ withdrawalId: string; hash: string; action: unknown; signature: { r: string; s: string; v: number }; nonce: number; signer: string }>('POST', '/venue/withdraw', { withdrawal, assertion }); },
  // derivative mandates: approval (passkey), one signature per venue action WITHOUT a passkey inside the limits the signer enforces, revocation
  venueMandateApprove: (mandate: unknown, assertion: unknown) => { cached = null; return call<{ mandateId: string; hash: string; authorizationId: string }>('POST', '/venue/mandate/approve', { mandate, assertion }); },
  venueMandateSign: (p: { mandateId: string; sign: unknown; context?: unknown }) => { cached = null; return call<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string; mandateId: string; phase: string }>('POST', '/venue/mandate/sign', p); },
  // v8 GMX v2: the venue policy (passkey) and its revocation; orders go through `sign` with an intent carrying a `gmx` section
  gmxAuthorize: (authorization: unknown, assertion: unknown) => { cached = null; return call<{ authorizationId: string; hash: string }>('POST', '/venue/gmx/authorize', { authorization, assertion }); },
  gmxRevoke: (authorizationId: string) => { cached = null; return call<{ revoked: true; revokedAt: string }>('POST', '/venue/gmx/revoke', { authorizationId }); },
  venueMandateRevoke: (mandateId: string) => { cached = null; return call<{ revoked: true; revokedAt: string; windDownUntil: number }>('POST', '/venue/mandate/revoke', { mandateId }); },
};

/** The wallet's address on a network; fails closed when the signer has no key for it. */
export function addressFor(st: SignerStatus, network: string): string {
  const a = st.addresses[network];
  if (!a) throw new UserError('unsupported_network', 'the signer has no key for this network yet', 503);
  return a;
}
