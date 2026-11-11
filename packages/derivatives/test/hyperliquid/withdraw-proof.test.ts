// Replays the testnet proof of the withdrawal signature (scripts/hl-withdraw-testnet.mts --send --record, 2026-11-11): the real
// isolated signer signed `withdraw3` with a throwaway wallet key; the venue refused the unfunded account BY NAME, i.e. it
// recovered our address from the signature over its own hash of the action. No network here.
import { describe, expect, it } from 'vitest';
import { buildWithdraw3TypedDataOnly, recoverTypedDataSigner } from '../../src/venues/hyperliquid/index.ts';
import { raw } from './helpers.ts';

describe('testnet proof: withdraw3 signed by the wallet key', () => {
  const p = raw('testnet-withdraw-proof.json') as { network: 'testnet'; endpoint: string; account: string; request: { action: { type: string; hyperliquidChain: string; signatureChainId: string; destination: string; amount: string; time: number }; nonce: number; signature: { r: string; s: string; v: number }; vaultAddress: null; expiresAfter: null }; status: number; answer: { status: string; response: string } };
  it('was sent to the testnet endpoint only, as a withdrawal to the signing address itself', () => {
    expect(p.endpoint).toBe('https://api.hyperliquid-testnet.xyz/exchange');
    expect(p.request.action).toEqual({ type: 'withdraw3', hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', destination: p.account, amount: p.request.action.amount, time: p.request.nonce });
    expect([p.request.vaultAddress, p.request.expiresAfter]).toEqual([null, null]);
  });
  it('our typed data recovers the account from the recorded signature, and the venue named that same account', async () => {
    const a = p.request.action;
    const td = buildWithdraw3TypedDataOnly({ network: 'testnet', destination: a.destination, amount: a.amount, time: a.time }).typedData;
    expect(await recoverTypedDataSigner(td, p.request.signature)).toBe(p.account);
    expect(p.status).toBe(200);
    expect(p.answer).toEqual({ status: 'err', response: `Must deposit before performing actions. User: ${p.account}` });
    // the same signature read as a Mainnet action is someone else's
    const main = buildWithdraw3TypedDataOnly({ network: 'mainnet', destination: a.destination, amount: a.amount, time: a.time }).typedData;
    expect(await recoverTypedDataSigner(main, p.request.signature)).not.toBe(p.account);
  });
});
