/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-gmx-chain.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Read-only smoke of the GMX chain port (services/api/src/derivatives/gmx-chain.ts) against the registry's two public
// Arbitrum RPC endpoints: pins, roles, markets, gas parameters, the positions and pending orders of a public address through
// GMX's Reader, the events of a real recorded order. Nothing is signed or sent; no key exists here.
//     npx tsx scripts/smoke-gmx-chain.mts [address]      (tsx: the API sources are not strip-only TypeScript)
import { readFileSync } from 'node:fs';
import { GMX_PINS, decodeGmxEvent, gmxEventKey, gmxUsdFromRaw } from '@spw/derivatives/live';

Object.assign(process.env, { SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'x'.repeat(48) });
const { realGmxChain } = await import('../services/api/src/derivatives/gmx-chain.ts');
const chain = realGmxChain();
let failures = 0;
const check = (ok: boolean, label: string) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };

const pins = await chain.checkPins(null);
check(pins.ok, `pins on both RPC endpoints: bytecode of 8 contracts, 3 roles, router immutables, WNT, request expiration, 2 markets${pins.ok ? '' : ` — ${pins.problems.join('; ')}`}`);
const gas = await chain.executionGas();
check(gas.increase > 1_000_000n && gas.decrease > 1_000_000n, `execution gas priced by the contracts: increase ${gas.increase}, decrease ${gas.decrease}`);

const fx = JSON.parse(readFileSync(new URL('../packages/derivatives/test/fixtures/gmx-live/orders.json', import.meta.url), 'utf8')) as { items: { kind: string; tx: { from: string; blockNumber: string }; logs: { address: string; topics: string[]; data: string }[] }[] };
const item = fx.items.find((x) => x.kind === 'OrderCreated')!, ev = item.logs.map((l) => decodeGmxEvent(l)).find((e) => e?.eventName === 'OrderCreated')!, key = gmxEventKey(ev)!;
const who = process.argv[2] ?? item.tx.from;
const t = await chain.txParams(who);
check(t.baseFee > 0n && t.nonce >= 0, `base fee ${t.baseFee} wei, pending nonce of ${who}: ${t.nonce} (both endpoints agree)`);
const bal = await chain.balances(who);
check(bal.usdc >= 0n, `balances of ${who}: ${bal.usdc} USDC units, ${bal.eth} wei, allowance to the Router ${bal.usdcAllowance}`);
const ps = await chain.positions(who), os = await chain.orders(who);
check(Array.isArray(ps) && Array.isArray(os), `Reader: ${ps.length} position(s), ${os.length} pending order(s)${ps[0] ? ` — first: ${ps[0].isLong ? 'long' : 'short'} ${gmxUsdFromRaw(ps[0].sizeInUsd)} USD on ${ps[0].market}` : ''}`);
const evs = await chain.orderEvents(key, Number(BigInt(item.tx.blockNumber)));
check(evs.some((e) => e.event.eventName === 'OrderCreated' && gmxEventKey(e.event) === key), `events of the recorded order ${key.slice(0, 18)}… from its block: ${evs.map((e) => e.event.eventName).join(', ')}`);
const o = await chain.order(key);
check(o === null || o.account.toLowerCase() === item.tx.from.toLowerCase(), `Reader.getOrder of that key: ${o ? 'still pending' : 'no longer in the order store (executed or cancelled)'}`);
check((await chain.order(`0x${'00'.repeat(31)}01`)) === null, 'Reader.getOrder of a key that never existed: null');
const sim = await chain.simulate({ from: who, to: GMX_PINS.exchangeRouter.address, data: '0x7489ec23' + '00'.repeat(31) + '01', value: 0n }); // cancelOrder(0x…01)
check(sim !== null && !sim.unreachable, `eth_call of cancelOrder(unknown key) on both endpoints: refused by the contracts (${sim?.error.slice(0, 60)})`);
console.log(failures === 0 ? 'All checks passed (read only).' : `${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
