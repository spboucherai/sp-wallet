/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/hyperliquid/live-proof.test.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Replay of what scripts/hl-live-testnet.mts recorded on the Hyperliquid TESTNET (unfunded run): the isolated signer's two keys
// at work. For every request that was sent, the signature is re-verified here against OUR hash of the recorded payload, and
// the venue's answer must name the very address we recover — the venue computed the same hash, expiry included.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApproveAgent, l1SignPayload, recoverTypedDataSigner } from '../../src/venues/hyperliquid/signing.ts';

interface Exchange { step: string; request?: { action: any; nonce: number; signature: unknown; vaultAddress: string | null; expiresAfter: number | null }; status?: number; answer: any }
const proof = JSON.parse(readFileSync(new URL('../fixtures/hyperliquid/testnet-live-proof.json', import.meta.url), 'utf8')) as { network: string; account: string; agent: string; exchanges: Exchange[] };
const sent = proof.exchanges.filter((e) => e.request);

describe('testnet proof of the live signing path (recorded)', () => {
  it('was recorded on testnet with two different keys', () => {
    expect(proof.network).toBe('testnet');
    expect(proof.account).toMatch(/^0x[0-9a-f]{40}$/); expect(proof.agent).toMatch(/^0x[0-9a-f]{40}$/);
    expect(proof.agent).not.toBe(proof.account);
    expect(sent.map((e) => e.request!.action.type)).toEqual(['approveAgent', 'order', 'cancelByCloid', 'updateLeverage']);
  });

  it('approveAgent: signed by the WALLET key, naming the trading key; the venue recovered the wallet key and asked for a deposit', async () => {
    const e = sent[0]!, a = e.request!.action;
    expect(a.agentAddress).toBe(proof.agent);
    expect(a.agentName).toMatch(/^spw-live valid_until \d{13}$/);
    const td = buildApproveAgent({ network: 'testnet', agentAddress: a.agentAddress, agentName: a.agentName, nonce: a.nonce, signatureChainId: a.signatureChainId }).typedData;
    expect(await recoverTypedDataSigner(td, e.request!.signature)).toBe(proof.account);
    expect(e.status).toBe(200);
    expect(e.answer).toEqual({ status: 'err', response: `Must deposit before performing actions. User: ${proof.account}` });
    // the same refusal, reached through the API's authorization route
    const viaApi = proof.exchanges.find((x) => x.step.startsWith('API authorization/approve'))!;
    expect(viaApi.status).toBe(422);
    expect(viaApi.answer.message).toContain(`Must deposit before performing actions. User: ${proof.account}`);
  });

  it('order, cancel and leverage change: signed by the TRADING key with a venue expiry; the venue recovered the trading key', async () => {
    for (const e of sent.slice(1)) {
      const r = e.request!;
      expect(r.vaultAddress, e.step).toBeNull();
      expect(r.expiresAfter, e.step).toBe(r.nonce + 90_000);                                   // every signed action dies after 90 s
      const td = l1SignPayload(r.action, { network: 'testnet', nonce: r.nonce, vaultAddress: null, expiresAfter: r.expiresAfter }).typedData;
      expect(await recoverTypedDataSigner(td, r.signature), e.step).toBe(proof.agent);
      expect(e.answer, e.step).toEqual({ status: 'err', response: `User or API Wallet ${proof.agent} does not exist.` });
      expect(JSON.stringify(e.answer)).not.toContain(proof.account);                           // the wallet key is nowhere in the trading path
    }
    const order = sent[1]!.request!.action.orders[0];
    expect(order).toMatchObject({ a: 3, b: true, r: false, t: { limit: { tif: 'Alo' } } });   // BTC is asset 3 on testnet (pinned table)
    expect(order.c).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('the signer refused, with its own exchange price, what it must refuse', () => {
    const refusals = Object.fromEntries(proof.exchanges.filter((e) => e.step.startsWith('signer: ')).map((e) => [e.step.slice(8), String(e.answer)]));
    expect(refusals['order at half the market price (passkey-approved all the same)']).toMatch(/^signer_price: price \d+ is more than 1000 bps away from the signer's own BTC price \d+/);
    expect(refusals['order above the authorized notional']).toMatch(/^signer_policy: order notional/);
    expect(refusals['order on an instrument outside the authorization']).toMatch(/^signer_policy: hyperliquid:ETH is not allowed/);
    expect(refusals['payload differs from the order shown for approval']).toMatch(/^signer_mismatch/);
    expect(refusals['an approveAgent for another address smuggled through /venue/sign']).toMatch(/only be signed through \/venue\/authorize/);
    expect(refusals['a transfer (usdClassTransfer) smuggled through /venue/sign']).toMatch(/not an order, a cancel or a leverage change/);
    expect(refusals['a cancel after revocation']).toMatch(/^signer_revoked/);
    expect(refusals['an order after revocation']).toMatch(/^signer_revoked/);
  });
});
