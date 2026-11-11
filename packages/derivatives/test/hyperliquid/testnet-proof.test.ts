// The testnet proof recorded on 2026-11-11 by `scripts/hl-testnet.mts proof --record` (fixtures/hyperliquid/testnet-exchange-proof.json):
// a throwaway key generated in memory, an account that never existed on the venue. Replayed here without network.
import { describe, expect, it } from 'vitest';
import { VenueError } from '../../src/index.ts';
import { createHlHttp, createHlTrading, l1SignPayload, recoverTypedDataSigner, type HlUserSignPayload } from '../../src/venues/hyperliquid/index.ts';
import { raw, replay, universe } from './helpers.ts';

const proof = raw('testnet-exchange-proof.json') as { account: string; exchanges: { step: string; request: any; status: number; answer: any; namesSigner: boolean }[] };
const t = universe('testnet');
const trading = (expiresAfterMs: number | null) => createHlTrading({ network: 'testnet', assets: t.assets, expiresAfterMs });
const good = proof.exchanges.filter((x) => !x.step.startsWith('WRONG')), wrong = proof.exchanges.filter((x) => x.step.startsWith('WRONG'));
const l1 = (r: any) => l1SignPayload(r.action, { network: 'testnet', nonce: r.nonce, vaultAddress: r.vaultAddress, expiresAfter: r.expiresAfter }).typedData;

describe('hyperliquid testnet proof (recorded)', () => {
  it('every correctly signed action recovers to OUR address locally, and the venue named that same address in its refusal', async () => {
    expect(good.map((x) => x.request.action.type)).toEqual(['approveAgent', 'order', 'order', 'cancel', 'cancelByCloid', 'updateLeverage', 'order']);
    for (const x of good) {
      const r = x.request;
      expect(x.status).toBe(200);
      expect(x.answer.status).toBe('err');
      expect(x.answer.response).toContain(proof.account);
      const td = r.action.type === 'approveAgent'
        ? (trading(null).buildApproveAgent({ agentAddress: r.action.agentAddress, agentName: r.action.agentName ?? null, nonce: r.nonce }).sign.payload as HlUserSignPayload).typedData
        : l1(r);
      expect(await recoverTypedDataSigner(td, r.signature)).toBe(proof.account);
    }
    expect(good[0]!.answer.response).toBe(`Must deposit before performing actions. User: ${proof.account}`);
    for (const x of good.slice(1)) expect(x.answer.response).toBe(`User or API Wallet ${proof.account} does not exist.`);
    expect(good[6]!.request.expiresAfter).toBe(good[6]!.request.nonce + 60_000);
  });

  it('describe() reads each recorded action back', () => {
    const kinds = good.map((x) => {
      const r = x.request, user = r.action.type === 'approveAgent', tr = trading(r.expiresAfter === null ? null : r.expiresAfter - r.nonce);
      const payload = user
        ? tr.buildApproveAgent({ agentAddress: r.action.agentAddress, agentName: r.action.agentName ?? null, nonce: r.nonce }).sign.payload
        : { scheme: 'l1', action: r.action, nonce: r.nonce, vaultAddress: r.vaultAddress, expiresAfter: r.expiresAfter, typedData: l1(r) };
      return tr.describe({ venue: 'hyperliquid', network: 'testnet', kind: user ? 'hl_user' : 'hl_l1', payload }).kind;
    });
    expect(kinds).toEqual(['approve_agent', 'order', 'order', 'cancel', 'cancel', 'leverage', 'order']);
  });

  it('wrong signatures were refused differently: another address, or no recovery at all', async () => {
    expect(wrong.length).toBe(4);
    for (const x of wrong) { expect(x.answer.status).toBe('err'); expect(x.answer.response).not.toContain(proof.account); }
    expect(wrong[3]!.answer.response).toBe('Unable to recover signer.');
    // the address the venue named is exactly the one our own code recovers from that signature over the submitted payload
    for (const x of wrong.slice(0, 3)) expect(x.answer.response).toBe(`User or API Wallet ${await recoverTypedDataSigner(l1(x.request), x.request.signature)} does not exist.`);
  });

  it('replayed through submit(): VenueError rejected, with the venue\'s words, and the same request body', async () => {
    const x = good[1]!, r = replay({ exchange: { status: x.status, body: x.answer } }), now = () => x.request.nonce;
    const tr = createHlTrading({ network: 'testnet', assets: t.assets, http: createHlHttp({ network: 'testnet', fetch: r.fetchImpl, now }), now });
    try { await tr.submit(x.request.action, x.request.signature, x.request.nonce); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(VenueError); expect((e as VenueError).code).toBe('rejected'); expect((e as VenueError).message).toContain('does not exist'); }
    expect(r.calls[0]!.body).toEqual(x.request);
  });
});
