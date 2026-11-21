/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-swap-cctp.mts
 * Module           : scripts
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

// Live READ-ONLY check of the CCTP quote adapter. Nothing is built, signed or broadcast.
//   1. on-chain: every pinned CCTP V2 contract/program has code and reports the expected domain, version and wiring
//   2. Iris: the live fee schedule for every route among the wallet's CCTP networks (USDC) and the EURC routes
//   3. adapter: real quotes for realistic small transfers, with latency, checked against a market reference (CoinGecko)
// Iris allows 40 requests/s and blocks an offender for five minutes: the route sweep is paced. Run once, not in a loop.
//   npx tsx scripts/smoke-swap-cctp.mts
import { NETWORKS, findProgramAddress, formatUnits, getNetwork } from '@spw/core';
import { httpClient, checkQuote, type AssetRef, type SwapQuote, type SwapQuoteRequest } from '../packages/swap/src/index.ts';
import { CCTP_API, CCTP_CHAINS, CCTP_EVM, CCTP_SOLANA, CCTPX, USDC_BURN_LIMIT, createCctpProvider, evmAddressToBytes32, solanaAddressToBytes32 } from '../packages/swap/src/providers/cctp.ts';

let failed = 0;
let quiet: string[] | null = null; // when set, passing checks are collected (one summary line per chain) instead of printed
const ok = (cond: boolean, label: string, detail = '') => {
  if (!cond) failed++;
  if (cond && quiet) { quiet.push(label.replace(/ 0x[0-9a-fA-F]{40}| [1-9A-HJ-NP-Za-km-z]{43,44}(?= )/g, '') + (detail.startsWith('=') || /USDC:|bytes/.test(detail) ? ` ${detail.split(':')[0]}` : '')); return; }
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = (network: string, symbol: string): AssetRef => ({ network, asset: getNetwork(network).tokens.find((t) => t.symbol === symbol)!.id });
const chains = Object.entries(CCTP_CHAINS);

async function rpc(network: string, method: string, params: unknown[]): Promise<any> {
  let last: unknown;
  for (const url of getNetwork(network).rpc) {
    try {
      const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) })).json() as { result?: unknown; error?: unknown };
      if (r.error) throw new Error(JSON.stringify(r.error));
      return r.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const call = (network: string, to: string, data: string) => rpc(network, 'eth_call', [{ to, data }, 'latest']) as Promise<string>;
const word = (v: number | bigint | string) => (typeof v === 'string' ? v.replace(/^0x/, '') : v.toString(16)).padStart(64, '0');
const asAddress = (w: string) => `0x${w.slice(-40)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// function selectors (keccak-256 of the signature, first four bytes)
const SEL = { localDomain: '0x8d3638f4', version: '0x54fd4d50', messageBodyVersion: '0x9cdbb181', localMessageTransmitter: '0x2c121921', localMinter: '0xcb75c11c', remoteTokenMessengers: '0x82a5e665', burnLimitsPerMessage: '0xa56ec632', resolveTokenManager: '0xf1761e84', resolveTokenAddress: '0x5bc8ccc6' };

console.log('== 1. On-chain check of the pinned CCTP V2 deployments ==');
for (const [network, c] of chains) {
  const net = getNetwork(network);
  quiet = [];
  try {
    if (net.family === 'evm') {
      for (const [name, address] of Object.entries(CCTP_EVM)) { const code = await rpc(network, 'eth_getCode', [address, 'latest']) as string; ok(code.length > 2, `${name} ${address} has code`, `${(code.length - 2) / 2} bytes`); }
      ok(Number(BigInt(await call(network, CCTP_EVM.messageTransmitter, SEL.localDomain))) === c.domain, 'MessageTransmitterV2.localDomain()', `= ${c.domain}`);
      ok(BigInt(await call(network, CCTP_EVM.messageTransmitter, SEL.version)) === 1n, 'MessageTransmitterV2.version()', '= 1 (the V2 message format)');
      ok(BigInt(await call(network, CCTP_EVM.tokenMessenger, SEL.messageBodyVersion)) === 1n, 'TokenMessengerV2.messageBodyVersion()', '= 1');
      ok(same(asAddress(await call(network, CCTP_EVM.tokenMessenger, SEL.localMessageTransmitter)), CCTP_EVM.messageTransmitter), 'TokenMessengerV2.localMessageTransmitter()', 'is the pinned MessageTransmitterV2');
      ok(same(asAddress(await call(network, CCTP_EVM.tokenMessenger, SEL.localMinter)), CCTP_EVM.tokenMinter), 'TokenMessengerV2.localMinter()', 'is the pinned TokenMinterV2');
      const limit = BigInt(await call(network, CCTP_EVM.tokenMinter, SEL.burnLimitsPerMessage + word(token(network, 'USDC').asset)));
      ok(limit > 0n && limit <= USDC_BURN_LIMIT, 'TokenMinterV2.burnLimitsPerMessage(registry USDC)', `${formatUnits(limit, 6)} USDC: the registry token is the burnable one`);
      const peers: string[] = [];
      for (const [other, oc] of chains) {
        if (other === network) continue;
        const remote = await call(network, CCTP_EVM.tokenMessenger, SEL.remoteTokenMessengers + word(oc.domain));
        const expected = getNetwork(other).family === 'evm' ? evmAddressToBytes32(CCTP_EVM.tokenMessenger) : solanaAddressToBytes32(CCTP_SOLANA.tokenMessengerMinter);
        if (same(remote, expected)) peers.push(other); else ok(false, `remoteTokenMessengers(${oc.domain})`, `${remote} is not the pinned ${other} messenger`);
      }
      ok(peers.length === chains.length - 1, 'remoteTokenMessengers(domain) is the pinned messenger of every other wallet network', peers.join(', '));
      if (c.eurc) {
        const code = await rpc(network, 'eth_getCode', [CCTPX.service, 'latest']) as string;
        ok(code.length > 2, `CrossChainTokenService ${CCTPX.service} has code`);
        ok(same(asAddress(await call(network, CCTPX.service, SEL.resolveTokenManager + word(CCTPX.eurcTokenId))), CCTPX.eurcTokenManager), 'resolveTokenManager(EURC)', 'is the pinned TokenManager');
        ok(same(asAddress(await call(network, CCTPX.service, SEL.resolveTokenAddress + word(CCTPX.eurcTokenId))), token(network, 'EURC').asset), 'resolveTokenAddress(EURC)', 'is the registry EURC');
      }
    } else {
      for (const [name, address] of Object.entries(CCTP_SOLANA)) { const a = await rpc(network, 'getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]); ok(a?.value?.executable === true, `${name} ${address} is an executable program`, `owner ${a?.value?.owner}`); }
      const state = findProgramAddress([new TextEncoder().encode('message_transmitter')], CCTP_SOLANA.messageTransmitter);
      const acc = await rpc(network, 'getAccountInfo', [state, { encoding: 'base64' }]);
      const data = Buffer.from(acc.value.data[0], 'base64');
      // anchor discriminator (8) + owner, pending_owner, attester_manager, pauser (4 × 32) + paused (1) + local_domain u32 + version u32
      ok(acc.value.owner === CCTP_SOLANA.messageTransmitter && data.readUInt32LE(137) === c.domain, `MessageTransmitterV2 state ${state}: local_domain`, `= ${data.readUInt32LE(137)}`);
      ok(data.readUInt32LE(141) === 1, 'MessageTransmitterV2 state: version', `= ${data.readUInt32LE(141)}`);
      const mint = token(network, 'USDC').asset;
      const local = findProgramAddress([new TextEncoder().encode('local_token'), Buffer.from(solanaAddressToBytes32(mint).slice(2), 'hex')], CCTP_SOLANA.tokenMessengerMinter);
      const lt = await rpc(network, 'getAccountInfo', [local, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
      ok(lt?.value?.owner === CCTP_SOLANA.tokenMessengerMinter, `local_token account for the registry USDC mint exists (${local})`);
    }
  } catch (e) { ok(false, 'chain check', (e as Error).message?.slice(0, 160)); }
  console.log(`${network} (domain ${c.domain}): ${quiet.length} checks ok — ${quiet.join('; ')}`);
  quiet = null;
}

console.log('\n== 2. Live Iris fee schedule among the wallet\'s CCTP networks ==');
const iris = async (path: string, init?: RequestInit) => { const r = await fetch(`${CCTP_API}${path}`, { ...init, signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json() as any }; };
const names = chains.map(([n]) => n);
console.log('USDC Fast Transfer fee, bps (rows: source, columns: destination; "-" = Fast not offered from that source; Standard is 0 bps on every route below unless shown)');
console.log(''.padEnd(11) + names.map((n) => n.slice(0, 9).padStart(10)).join(''));
let routes = 0; const forward: string[] = [];
for (const [s, sc] of chains) {
  let row = s.padEnd(11);
  for (const [d, dc] of chains) {
    if (s === d) { row += '·'.padStart(10); continue; }
    const r = await iris(`/v2/burn/USDC/fees/${sc.domain}/${dc.domain}?forward=true`); await sleep(120);
    if (r.status !== 200) { failed++; row += `E${r.status}`.padStart(10); continue; }
    routes++;
    const fast = r.body.find((x: any) => x.finalityThreshold === 1000), std = r.body.find((x: any) => x.finalityThreshold === 2000);
    row += ((sc.fastSource ? String(fast?.minimumFee) : '-') + (std?.minimumFee ? `/s${std.minimumFee}` : '')).padStart(10);
    if (!sc.fastSource && fast?.minimumFee) { failed++; row += '!'; } // a non-zero Fast fee from a chain we pinned as not Fast-capable would mean the table is stale
    if (s === 'ethereum') forward.push(`${d} ${formatUnits(BigInt(std.forwardFee.med), 6)}`);
  }
  console.log(row);
}
ok(routes === chains.length * (chains.length - 1), `${routes} USDC routes answered by Iris`);
console.log(`  Forwarding Service fee (Circle submits the mint), USDC, from ethereum to: ${forward.join(' | ')}`);
const allowance = await iris('/v2/fastBurn/USDC/allowance');
console.log(`  Fast Transfer allowance now: ${allowance.body.allowance} USDC (updated ${allowance.body.lastUpdated})`);
const tokens = await iris(`/v2/cctpx/tokens?tokenid=${CCTPX.eurcTokenId}`);
const deployments: any[] = tokens.body.data?.[0]?.deployments ?? [];
for (const [n, c] of chains.filter(([, c]) => c.eurc)) { const d = deployments.find((x) => x.domainId === c.domain); ok(!!d && d.enabled && same(d.tokenAddress, token(n, 'EURC').asset) && same(d.tokenManagerAddress, CCTPX.eurcTokenManager), `EURC on ${n}: Iris lists the registry token and the pinned TokenManager, enabled`); }
const eurcElsewhere = chains.filter(([n, c]) => !c.eurc && deployments.some((x) => x.domainId === c.domain) && getNetwork(n).tokens.some((t) => t.symbol === 'EURC'));
ok(eurcElsewhere.length === 0, 'no other wallet network has both a registry EURC and a CCTP EURC deployment');
const keys = await iris('/v2/publicKeys');
console.log(`  attester public keys: ${keys.body.publicKeys.filter((k: any) => k.cctpVersion === 2).length} for V2, ${keys.body.publicKeys.filter((k: any) => k.cctpVersion === 1).length} for V1`);

console.log('\n== 3. Adapter quotes (live) ==');
const cg = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,euro-coin,ethereum,solana,avalanche-2,polygon-ecosystem-token,hyperliquid&vs_currencies=usd', { signal: AbortSignal.timeout(10_000) })).json() as Record<string, { usd: number }>;
const USD: Record<string, number> = { USDC: cg['usd-coin']!.usd, EURC: cg['euro-coin']!.usd, ETH: cg.ethereum!.usd, SOL: cg.solana!.usd, AVAX: cg['avalanche-2']!.usd, POL: cg['polygon-ecosystem-token']!.usd, HYPE: cg.hyperliquid!.usd };
console.log(`  CoinGecko: ${Object.entries(USD).map(([k, v]) => `${k} $${v}`).join(', ')}`);
ok(Math.abs(USD.USDC! - 1) < 0.01, 'USDC is at its peg on the market', `$${USD.USDC}`);
const def = (a: AssetRef) => { const n = NETWORKS[a.network]!; return a.asset === 'native' ? n.native : n.tokens.find((t) => t.id.toLowerCase() === a.asset.toLowerCase())!; };
const usd = (a: AssetRef, amount: bigint) => (Number(amount) / 10 ** def(a).decimals) * USD[def(a).symbol]!; // display only
const EVM_A = '0x28C6c06298d514Db089934071355E5743bf21d60', SOL_A = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'; // public exchange accounts, used only as sender/recipient of a quote
const who = (n: string) => (getNetwork(n).family === 'evm' ? EVM_A : SOL_A);
const provider = createCctpProvider(), http = httpClient('cctp');
const cases: [string, string, string, string][] = [
  ['USDC', 'ethereum', 'base', '25'], ['USDC', 'base', 'solana', '25'], ['USDC', 'solana', 'arbitrum', '40'], ['USDC', 'arbitrum', 'optimism', '50'],
  ['USDC', 'polygon', 'avalanche', '20'], ['USDC', 'avalanche', 'hyperevm', '30'], ['USDC', 'hyperevm', 'ethereum', '50'], ['USDC', 'optimism', 'polygon', '0.000001'],
  ['EURC', 'base', 'ethereum', '25'], ['EURC', 'avalanche', 'base', '25'],
];
for (const [sym, from, to, human] of cases) {
  const f = token(from, sym), t = token(to, sym), amountIn = BigInt(Math.round(Number(human) * 1e6));
  const req: SwapQuoteRequest = { from: f, to: t, amountIn, sender: who(from), recipient: who(to), slippageBps: 50 };
  const t0 = performance.now();
  let quotes: SwapQuote[] = [];
  try { quotes = await provider.quote(req, { signal: AbortSignal.timeout(8_000), http, now: Date.now }); }
  catch (e) { ok(false, `${human} ${sym} ${from} -> ${to}`, `${(e as { code?: string }).code} ${(e as Error).message}`); continue; }
  const ms = Math.round(performance.now() - t0);
  console.log(`${human} ${sym} ${from} -> ${to}: ${quotes.length} quote(s) in ${ms} ms`);
  for (const q of quotes) {
    const bad = checkQuote(q, req, Date.now());
    const rate = Number(q.amountOut) / Number(amountIn), raw = q.raw as { transfer: string; forwardingService?: { med: number } | null };
    const extra = q.fees.filter((x) => !x.includedInOutput).map((x) => `${formatUnits(x.amount, def(x.asset).decimals)} ${def(x.asset).symbol} on ${x.asset.network} ($${usd(x.asset, x.amount).toFixed(4)}, ${x.kind}${x.estimated ? ', est.' : ''})`);
    const proto = q.fees.filter((x) => x.includedInOutput).map((x) => `${formatUnits(x.amount, 6)} ${sym}`);
    console.log(`  ${raw.transfer.padEnd(8)} out ${formatUnits(q.amountOut, 6)} (min ${formatUnits(q.minAmountOut, 6)}) ~${q.estimatedSeconds} s | deducted at mint: ${proto.join(', ') || 'nothing'} | paid on top: ${extra.join('; ')}${raw.forwardingService ? ` | forwarding alternative ${formatUnits(BigInt(raw.forwardingService.med), 6)} USDC` : ''}`);
    // the market reference for a 1:1 burn-and-mint of the same asset is 1; the only deviation allowed is the protocol fee (≤ 0.5 %)
    ok(bad === null && rate <= 1 && rate >= 0.995 && q.minAmountOut <= q.amountOut, `    structurally valid, rate ${rate.toFixed(6)} within [0.995, 1] of the 1:1 reference (${sym} market price $${USD[sym]})`, bad ?? '');
  }
  if (quotes.length) console.log(`    ${quotes[0]!.steps[0]!.via[3]}`);
  await sleep(300);
}
console.log('refusals (no HTTP call is made for a pair the adapter does not serve):');
const usdt = token('ethereum', 'USDT'), bridgedPolygonUsdc: AssetRef = { network: 'polygon', asset: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' };
ok(!provider.supportsPair(usdt, token('base', 'USDC')), '  USDT -> USDC');
ok(!provider.supportsPair(bridgedPolygonUsdc, token('base', 'USDC')), '  bridged USDC.e on Polygon (not in the registry)');
ok(!provider.supportsPair(token('ethereum', 'USDC'), { network: 'bsc', asset: 'native' }), '  USDC -> BNB Smart Chain');
ok(!provider.supportsPair(token('solana', 'EURC'), token('base', 'EURC')), '  EURC from Solana (CCTP for non-USDC is EVM only)');
ok(!provider.supportsPair(token('ethereum', 'USDC'), token('ethereum', 'USDC')), '  same network');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
