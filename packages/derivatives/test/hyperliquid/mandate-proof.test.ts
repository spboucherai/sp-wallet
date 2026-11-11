// Replay of what scripts/hl-mandate-testnet.mts recorded on the Hyperliquid TESTNET (unfunded run): actions signed by the
// trading key under a derivative MANDATE, without a passkey. For every request that was sent, the signature is re-verified here
// against OUR hash of the recorded payload, and the venue's answer must name the very address we recover.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApproveAgent, l1SignPayload, recoverTypedDataSigner } from '../../src/venues/hyperliquid/signing.ts';

interface Exchange { step: string; request?: { action: any; nonce: number; signature: unknown; vaultAddress: string | null; expiresAfter: number | null }; status?: number; answer: any }
const proof = JSON.parse(readFileSync(new URL('../fixtures/hyperliquid/testnet-mandate-proof.json', import.meta.url), 'utf8')) as { network: string; account: string; agent: string; exchanges: Exchange[] };
const sent = proof.exchanges.filter((e) => e.request);

describe('testnet proof of the mandate signing path (recorded)', () => {
  it('was recorded on testnet; one approval by the wallet key, then three actions by the trading key', () => {
    expect(proof.network).toBe('testnet');
    expect(proof.agent).not.toBe(proof.account);
    expect(sent.map((e) => e.request!.action.type)).toEqual(['approveAgent', 'updateLeverage', 'order', 'cancelByCloid']);
  });

  it('the authorization the mandate extends: approveAgent by the WALLET key; the venue asked for a deposit', async () => {
    const e = sent[0]!, a = e.request!.action;
    const td = buildApproveAgent({ network: 'testnet', agentAddress: a.agentAddress, agentName: a.agentName, nonce: a.nonce, signatureChainId: a.signatureChainId }).typedData;
    expect(await recoverTypedDataSigner(td, e.request!.signature)).toBe(proof.account);
    expect(e.answer).toEqual({ status: 'err', response: `Must deposit before performing actions. User: ${proof.account}` });
  });

  it('leverage change, reduce-only order and cancel signed under the mandate: the trading key, a 30 s venue expiry; the venue recovered the trading key', async () => {
    for (const e of sent.slice(1)) {
      const r = e.request!;
      expect(r.vaultAddress, e.step).toBeNull();
      expect(r.expiresAfter, e.step).toBe(r.nonce + 30_000);
      const td = l1SignPayload(r.action, { network: 'testnet', nonce: r.nonce, vaultAddress: null, expiresAfter: r.expiresAfter }).typedData;
      expect(await recoverTypedDataSigner(td, r.signature), e.step).toBe(proof.agent);
      expect(e.answer, e.step).toEqual({ status: 'err', response: `User or API Wallet ${proof.agent} does not exist.` });
      expect(JSON.stringify(e.answer)).not.toContain(proof.account);
    }
    expect(sent[1]!.request!.action).toMatchObject({ type: 'updateLeverage', asset: 3, isCross: true, leverage: 3 });
    expect(sent[2]!.request!.action.orders).toHaveLength(1);
    expect(sent[2]!.request!.action.orders[0]).toMatchObject({ a: 3, b: false, r: true, t: { limit: { tif: 'Ioc' } } });   // the only order sent is reduce-only
  });

  it('the signer read the testnet account itself, and refused what it must refuse', () => {
    const read = proof.exchanges.find((e) => e.step.startsWith('signer read'))!.answer;
    expect(read).toMatchObject({ accountValue: '0.0', totalNtlPos: '0.0', positions: [], openOrders: [] });
    expect(read.time).toBeGreaterThan(1_790_000_000_000);
    const refusals = Object.fromEntries(proof.exchanges.filter((e) => e.step.startsWith('signer: ')).map((e) => [e.step.slice(8), String(e.answer)]));
    const find = (start: string) => Object.entries(refusals).find(([k]) => k.startsWith(start))![1];
    expect(find('order buy')).toMatch(/^signer_floor_equity: the venue reports an account value of 0\.0, below the mandate's floor of 5/);
    expect(find('leverage 4×')).toMatch(/^signer_leverage_exceeded/);
    expect(find('reduce-only order at half the market price')).toMatch(/^signer_price: price \d+ is more than 1000 bps away from the signer's own BTC price \d+/);
    expect(find('order above the mandate\'s notional')).toMatch(/^signer_order_notional/);
    expect(find('order on an instrument outside the mandate')).toMatch(/^signer_instrument: hyperliquid:ETH/);
    expect(find('the API describes a plain sell as reduce-only')).toMatch(/^signer_mismatch: .*reduce-only/);
    expect(find('the same client id again')).toMatch(/^signer_replay/);
    expect(find('an approveAgent for another address')).toMatch(/not an order, a cancel or a leverage change/);
    expect(find('a signature valid for more than 120 s')).toMatch(/^signer_policy/);
    expect(find('an order that can add exposure during the wind-down')).toMatch(/^signer_wind_down/);
    expect(find('a leverage change during the wind-down')).toMatch(/^signer_wind_down/);
    expect(find('a reduce-only order after the AUTHORIZATION was revoked')).toMatch(/^signer_revoked/);
    expect(find('a cancel after the authorization was revoked')).toMatch(/^signer_revoked/);
  });
});
