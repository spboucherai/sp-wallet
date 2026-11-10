import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Policy } from '@spw/core';
import { config, UserError } from './config.ts';

export interface SignerStatus {
  keyId: string; addresses: { evm: string; btc: string; sol: string }; halted: boolean; enrollmentOpen: boolean;
  credentials: { id: string; addedAt: string }[]; policy: Policy; spentToday: Record<string, string>; journalHead: string | null; journalLength: number;
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
  sign: (intent: unknown, assertion: unknown) => { cached = null; return call<{ raw: string; txid: string; hash: string }>('POST', '/sign', { intent, assertion }); },
  halt: () => { cached = null; return call<{ ok: true }>('POST', '/halt', {}); },
};

export function addressFor(st: SignerStatus, family: 'evm' | 'btc' | 'sol'): string { return st.addresses[family]; }
