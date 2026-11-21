/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/agent-engine.test.ts
 * Module           : services
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

import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/agents/routes.ts';

let checkWeights: typeof import('../src/agents/engine.ts').checkWeights, planOrder: typeof import('../src/agents/engine.ts').planOrder;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_WORKERS: 'off' });
  ({ checkWeights, planOrder } = await import('../src/agents/engine.ts'));
});
const agent = (risk: Partial<AgentRow['risk']> = {}) => ({ id: 'a', universe: ['ETH', 'LINK'], risk: { maxExposurePct: 50, maxLossPct: 5, maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 50, ...risk } }) as unknown as AgentRow;
const hold = (usdc: number, eth = 0, link = 0) => [{ symbol: 'USDC', id: '0xusdc', decimals: 6, units: usdc }, { symbol: 'ETH', id: 'native', decimals: 18, units: eth }, { symbol: 'LINK', id: '0xlink', decimals: 18, units: link }];
const px = { ETH: 2000, LINK: 10 };

describe('agent engine: weights', () => {
  it('accepts only universe symbols with weights in [0, 1] summing to at most 1', () => {
    expect(checkWeights({ ETH: 0.4 }, ['ETH', 'LINK'])).toEqual({ ETH: 0.4, LINK: 0 });
    for (const bad of [null, [], { BTC: 0.1 }, { ETH: -0.1 }, { ETH: 1.2 }, { ETH: NaN }, { ETH: '0.5' }, { ETH: 0.7, LINK: 0.7 }]) expect(() => checkWeights(bad, ['ETH', 'LINK'])).toThrow();
  });
});
describe('agent engine: order planning', () => {
  it('buys toward the target, capped by the order limit and the exposure limit', () => {
    const p = planOrder(agent(), { ETH: 1, LINK: 0 }, hold(100), px, 0, 0); // wants 100 %, exposure cap 50 % → 50 USD, order cap 25
    expect(p.order).toMatchObject({ fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 25_000000n });
    expect(planOrder(agent({ maxOrderUsd: 500 }), { ETH: 1, LINK: 0 }, hold(100), px, 0, 0).order!.amountIn).toBe(50_000000n);
  });
  it('sells before it buys, and never more than it holds', () => {
    const p = planOrder(agent(), { ETH: 0, LINK: 0.4 }, hold(60, 0.01, 0), px, 0, 0); // 20 USD of ETH to sell, 32 USD of LINK to buy
    expect(p.order).toMatchObject({ fromSymbol: 'ETH', toSymbol: 'USDC', amountIn: 10n ** 16n });
  });
  it('does nothing at target, below the threshold, or once a daily limit is reached', () => {
    expect(planOrder(agent(), { ETH: 0.2, LINK: 0 }, hold(80, 0.01), px, 0, 0).order).toBeNull();
    expect(planOrder(agent(), { ETH: 0.21, LINK: 0 }, hold(80, 0.01), px, 0, 0).order).toBeNull(); // 1 USD away
    expect(planOrder(agent(), { ETH: 0.5, LINK: 0 }, hold(100), px, 99.5, 0).note).toMatch(/daily volume/);
    expect(planOrder(agent(), { ETH: 0.5, LINK: 0 }, hold(100), px, 0, 12).note).toMatch(/order count/);
    expect(planOrder(agent(), { ETH: 0.5, LINK: 0 }, hold(0), px, 0, 0).order).toBeNull();
  });
  it('limits an order to the room left in the daily volume', () => {
    expect(planOrder(agent(), { ETH: 0.5, LINK: 0 }, hold(100), px, 90, 3).order!.amountIn).toBe(10_000000n);
  });
});
