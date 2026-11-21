/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/scripts/gen-tokens.mts
 * Module           : core
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

// Reads research/candidates.json and writes packages/core/src/tokens.ts. A deployment is kept only when ALL of this holds;
// anything else is dropped and reported in research/dropped.txt — never silently kept:
//   1. first source — the issuer's (or, for a bridged representation, the network's / bridge's) own document states the address:
//      research/evidence.json, produced by scripts/check-sources.mts, has an entry for this exact address;
//   2. second, independent source — CoinGecko lists the same address for the coin id named by the candidate (research/cg.json,
//      refreshed by scripts/fetch-cg.mts), and that coin's symbol is the expected one;
//      EXTENSION (only when CoinGecko lists no address on that network, and only for OP-Stack networks): the canonical bridge's own
//      token mapping read on-chain — the L2 token names the L1 token and the Standard Bridge, and the L1 token is this asset's
//      Ethereum deployment, itself accepted through 1 + 2 + 3. Recorded per token as `second: 'op-bridge'`;
//   3. the chain itself — on BOTH RPC endpoints of the network: contract code exists, symbol() is the expected one, decimals()
//      agree (also with CoinGecko's when it gives them), totalSupply() > 0. Solana: an initialized SPL mint owned by a token
//      program, supply > 0, no transfer fee, no transfer hook, transferable. TRON: same as EVM through the java-tron HTTP API.
//   node packages/core/scripts/gen-tokens.mts      (run from the repository root)
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, hexToBigInt, hexToNumber, hexToString, parseAbi } from 'viem';
import { tronAddressBytes } from '../src/plugins/tron.ts';

/** the same two endpoints per network as packages/core/src/networks.ts */
const RPC: Record<string, string[]> = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
  optimism: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'], bsc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
  avalanche: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'], hyperevm: ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid.drpc.org'],
  solana: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
  tron: ['https://api.trongrid.io', 'https://tron-rpc.publicnode.com'] /* java-tron HTTP API, not JSON-RPC */ };
const CG: Record<string, string> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum-one', polygon: 'polygon-pos', optimism: 'optimistic-ethereum', bsc: 'binance-smart-chain', avalanche: 'avalanche', hyperevm: 'hyperevm', solana: 'solana', tron: 'tron' };
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const OP_STANDARD_BRIDGE = '0x4200000000000000000000000000000000000010', OP_STACK = new Set(['optimism', 'base']);
const bridgeAbi = parseAbi(['function l1Token() view returns (address)', 'function remoteToken() view returns (address)', 'function l2Bridge() view returns (address)', 'function bridge() view returns (address)']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  for (let k = 0; k < 5; k++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json() as any;
      if (j.error) throw Object.assign(new Error(j.error.message), { rpcError: true, revert: /revert/i.test(j.error.message ?? '') });
      if (j.result === undefined) throw new Error('no result (rate limit?)'); // a throttled endpoint must never read as "no code"
      return j.result;
    } catch (e) { if (k === 4 || (e as any).revert) throw e; await sleep(1500 * (k + 1)); }
  }
}
/** TRON full-node HTTP API: read-only contract call, returns the ABI-encoded result. Fails on a revert or a missing contract. */
async function tronCall(url: string, contract: string, selector: string): Promise<`0x${string}`> {
  for (let k = 0; k < 5; k++) {
    try {
      const r = await fetch(url + '/wallet/triggerconstantcontract', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ owner_address: contract, contract_address: contract, function_selector: selector, parameter: '', visible: true }) });
      const j = await r.json() as any;
      if (j.result?.result !== true || j.result?.message || !j.constant_result?.[0]) throw new Error(`constant call ${selector} failed`);
      return `0x${j.constant_result[0]}`;
    } catch (e) { if (k === 4) throw e; await sleep(1500 * (k + 1)); }
  }
  throw new Error('unreachable');
}
const call = (url: string, to: string, data: string) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
const str = (raw: `0x${string}`): string => { try { return decodeAbiParameters([{ type: 'string' }], raw)[0]; } catch { return hexToString(raw, { size: 32 }); } }; // string, or bytes32 for a few old tokens
/** what one endpoint says about an EVM token */
async function readEvm(url: string, addr: string): Promise<{ sym: string; dec: number }> {
  const code = await rpc(url, 'eth_getCode', [addr, 'latest']);
  if (!code || code === '0x') throw new Error('no contract code');
  const dec = hexToNumber(await call(url, addr, encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' })));
  const sym = str(await call(url, addr, encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' })));
  if (hexToBigInt(await call(url, addr, encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }))) <= 0n) throw new Error('total supply is zero');
  return { sym, dec };
}
async function readTron(url: string, addr: string): Promise<{ sym: string; dec: number }> {
  const info = await (await fetch(url + '/wallet/getcontract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: addr, visible: true }), signal: AbortSignal.timeout(15000) })).json() as any;
  // a contract deployed by another contract has no creation `bytecode` in this answer, only the hash of its runtime code
  if (info.contract_address !== addr || !(info.bytecode || /^[0-9a-f]{64}$/.test(info.code_hash ?? ''))) throw new Error('no contract code');
  const dec = hexToNumber(await tronCall(url, addr, 'decimals()')), sym = str(await tronCall(url, addr, 'symbol()'));
  if (hexToBigInt(await tronCall(url, addr, 'totalSupply()')) <= 0n) throw new Error('total supply is zero');
  return { sym, dec };
}
async function readSol(url: string, mint: string): Promise<{ dec: number; program: 'token' | 'token2022'; ext: string[] }> {
  const a = (await rpc(url, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
  if (!a || a.data?.parsed?.type !== 'mint' || ![TOKEN, TOKEN22].includes(a.owner)) throw new Error('not an SPL mint');
  const info = a.data.parsed.info, exts: any[] = info.extensions ?? [], ext = exts.map((e) => e.extension);
  if (!info.isInitialized || BigInt(info.supply) <= 0n) throw new Error('mint not initialized or supply is zero');
  // Token-2022 mints with a transfer hook or a non-zero transfer fee change what "transfer" means: refuse them
  const fee = exts.find((e) => e.extension === 'transferFeeConfig')?.state;
  if (exts.find((e) => e.extension === 'transferHook')?.state?.programId) throw new Error('mint has an active transfer hook');
  if (fee && (fee.newerTransferFee?.transferFeeBasisPoints || fee.olderTransferFee?.transferFeeBasisPoints)) throw new Error('mint charges a transfer fee');
  if (ext.includes('nonTransferable')) throw new Error('non-transferable mint');
  return { dec: info.decimals, program: a.owner === TOKEN22 ? 'token2022' : 'token', ext };
}
/** both endpoints must answer and say the same thing */
async function both<T>(net: string, f: (url: string) => Promise<T>): Promise<T> {
  const [a, b] = await Promise.all(RPC[net]!.map((u) => f(u).catch((e) => { throw new Error(`${new URL(u).host}: ${(e as Error).message}`); })));
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`the two endpoints disagree: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return a!;
}

const cand = JSON.parse(readFileSync('research/candidates.json', 'utf8'));
const cg: Record<string, any> = JSON.parse(readFileSync('research/cg.json', 'utf8'));
const evidence: Record<string, { address: string; url: string; via: string }> = JSON.parse(readFileSync('research/evidence.json', 'utf8'));
type Dep = { address: string; decimals: number; program?: string; onchainSymbol?: string; name?: string; second?: string };
type Row = { symbol: string; network: string; address: string; decimals: number; onchainSymbol: string | null; first: string; firstVia: string; second: string };
const symbols = cand.tokens.map((t: any) => t.symbol);
if (new Set(symbols).size !== symbols.length) throw new Error('a symbol appears twice in candidates.json');
const results = new Map<string, { dep?: Dep; row?: Row; drop?: string }>();

async function one(t: any, net: string, raw: any, ethOk: () => Dep | undefined): Promise<{ dep: Dep; row: Row }> {
  const d = typeof raw === 'string' ? { a: raw } : raw, tag = `${t.symbol}@${net}`, evm = net !== 'solana' && net !== 'tron';
  const address: string = evm ? getAddress(d.a.toLowerCase()) : d.a;
  const same = (x: string) => (evm ? x.toLowerCase() === address.toLowerCase() : x === address);
  // 1. first source
  const ev = evidence[tag];
  if (!ev || !same(ev.address)) throw new Error('first source: the address was not found in the issuer / network document (no evidence entry)');
  // 2. second source
  const id: string | undefined = d.cg ?? t.cg, entry = id ? cg[id] : undefined, listed = entry?.platforms?.[CG[net]!];
  let second: string, cgDec: number | null = null;
  if (listed?.contract_address) {
    if (!same(listed.contract_address)) throw new Error(`second source differs: CoinGecko ${id} lists ${listed.contract_address}`);
    const okSym = [t.symbol, ...(t.alias ?? []), d.onchain, d.cgSymbol].filter(Boolean).map((s: string) => s.toUpperCase());
    if (!okSym.includes(String(entry.symbol).toUpperCase())) throw new Error(`second source is another coin: CoinGecko ${id} has symbol "${entry.symbol}"`);
    second = `coingecko:${id}`; cgDec = typeof listed.decimal_place === 'number' ? listed.decimal_place : null;
  } else if (d.second?.type === 'op-bridge' && OP_STACK.has(net)) {
    const l1 = ethOk();
    if (!l1 || l1.address.toLowerCase() !== String(d.second.l1).toLowerCase()) throw new Error('bridge mapping: the L1 token is not this asset\'s accepted Ethereum deployment');
    const got = await both(net, async (u) => {
      const addr = async (fns: ('l1Token' | 'remoteToken' | 'l2Bridge' | 'bridge')[]) => { for (const fn of fns) { try { return decodeAbiParameters([{ type: 'address' }], await call(u, address, encodeFunctionData({ abi: bridgeAbi, functionName: fn })))[0].toLowerCase(); } catch { /* next */ } } throw new Error('token does not expose its bridge mapping'); };
      return { l1: await addr(['l1Token', 'remoteToken']), bridge: await addr(['l2Bridge', 'bridge']) };
    });
    if (got.l1 !== l1.address.toLowerCase() || got.bridge !== OP_STANDARD_BRIDGE) throw new Error(`bridge mapping differs: L1 token ${got.l1}, bridge ${got.bridge}`);
    second = 'op-bridge';
  } else throw new Error(id ? `no second source: CoinGecko ${id} lists no address on this network` : 'no second source');
  // 3. the chain, on both endpoints
  let dep: Dep, onchain: string | null = null;
  if (net === 'solana') {
    const m = await both(net, (u) => readSol(u, address));
    dep = { address, decimals: m.dec, ...(m.program === 'token2022' ? { program: 'token2022' } : {}) };
  } else {
    const m = await both(net, (u) => (net === 'tron' ? (tronAddressBytes(address), readTron(u, address)) : readEvm(u, address)));
    const ok = d.onchain ? m.sym === d.onchain : [t.symbol, ...(t.alias ?? [])].some((s: string) => s.toUpperCase() === m.sym.toUpperCase());
    if (!ok) throw new Error(`on-chain symbol is "${m.sym}"`);
    onchain = m.sym;
    dep = { address, decimals: m.dec, ...(m.sym !== t.symbol ? { onchainSymbol: m.sym } : {}) };
  }
  if (cgDec !== null && cgDec !== dep.decimals) throw new Error(`decimals differ: chain ${dep.decimals}, CoinGecko ${cgDec}`);
  if (d.name) dep.name = d.name;
  if (second !== `coingecko:${id}`) dep.second = second;
  return { dep, row: { symbol: t.symbol, network: net, address, decimals: dep.decimals, onchainSymbol: onchain, first: ev.url, firstVia: ev.via, second } };
}
// one worker per network (public endpoints are rate-limited); Ethereum first, because bridge mappings refer to it
const order = ['ethereum', ...Object.keys(RPC).filter((n) => n !== 'ethereum')];
async function runNet(net: string): Promise<void> {
  for (const t of cand.tokens) {
    const raw = t.d[net]; if (raw === undefined) continue;
    const tag = `${t.symbol}@${net}`;
    try { results.set(tag, await one(t, net, raw, () => results.get(`${t.symbol}@ethereum`)?.dep)); console.log('ok  ', tag); }
    catch (e) { results.set(tag, { drop: (e as Error).message }); console.log('DROP', tag, (e as Error).message); }
    await sleep(net === 'tron' || net === 'solana' ? 900 : 150);
  }
}
await runNet('ethereum');
await Promise.all(order.slice(1).map(runNet));

const out: any[] = [], dropped: string[] = [], rows: Row[] = [], seen = new Map<string, string>();
for (const t of cand.tokens) {
  const deployments: Record<string, Dep> = {};
  for (const net of Object.keys(t.d)) {
    if (!(net in RPC)) { dropped.push(`${t.symbol}@${net}: unknown network`); continue; }
    const tag = `${t.symbol}@${net}`, r = results.get(tag)!;
    if (r.drop) { dropped.push(`${tag}: ${r.drop}`); continue; }
    const key = `${net}:${r.dep!.address.toLowerCase()}`;
    if (seen.has(key)) { dropped.push(`${tag}: same contract as ${seen.get(key)}`); continue; }
    seen.set(key, tag); deployments[net] = r.dep!; rows.push(r.row!);
  }
  if (!Object.keys(deployments).length) continue;
  const counts = new Map<number, number>(); for (const d of Object.values(deployments)) counts.set(d.decimals, (counts.get(d.decimals) ?? 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  out.push({ ...t, decimals: main, deployments });
}
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const body = out.map((t) => `  // ${t.source || 'sources per deployment: research/candidates.json'}\n  { symbol: ${q(t.symbol)}, name: ${q(t.name)}, decimals: ${t.decimals},${t.issuer ? ` issuer: ${q(t.issuer)},` : ''}${t.flags ? ` flags: ${q(t.flags)},` : ''} deployments: {\n${Object.entries(t.deployments as Record<string, Dep>).map(([n, d]) =>
  `    ${n}: { address: ${q(d.address)}${d.decimals !== t.decimals ? `, decimals: ${d.decimals}` : ''}${d.program ? `, program: ${q(d.program)}` : ''}${d.onchainSymbol ? `, onchainSymbol: ${q(d.onchainSymbol)}` : ''}${d.name ? `, name: ${q(d.name)}` : ''}${d.second ? `, second: ${q(d.second)}` : ''} },`).join('\n')}\n  } },`).join('\n');
writeFileSync('packages/core/src/tokens.ts', `// GENERATED by scripts/gen-tokens.mts on ${new Date().toISOString().slice(0, 10)} from research/candidates.json — do not edit by hand.
// Inclusion rule (docs/TOKENS.md): the issuer's or network's own document states the address (research/evidence.json), a second
// independent source agrees (CoinGecko's contract list; \`second\` names the source when it is another one), and the contract's own
// symbol()/decimals()/totalSupply() (EVM, TRON) or mint owner program/decimals/supply (Solana) match on both RPC endpoints.
// The API re-checks the on-chain part at every start.
export interface TokenDef {
  symbol: string; name: string; decimals: number;
  /** who issues the asset (different issuers never share a symbol on one network) */
  issuer?: string;
  /** behaviour worth knowing before holding it (freeze / pause powers, bridge representation…) */
  flags?: string;
  /** network id -> deployment. \`decimals\` overrides when a chain differs. \`onchainSymbol\`: what the contract itself returns when it is not the ticker.
   *  \`name\`: this deployment is another representation than the token's main one (bridged, exchange-pegged). \`second\`: second source when not CoinGecko. */
  deployments: Record<string, { address: string; decimals?: number; program?: 'token' | 'token2022'; onchainSymbol?: string; name?: string; second?: 'op-bridge' }>;
}
export const TOKENS: TokenDef[] = [
${body}
];
`);
for (const x of cand.excluded ?? []) dropped.push(`${x.symbol}: EXCLUDED — ${x.why}`);
writeFileSync('research/dropped.txt', dropped.join('\n') + '\n');
writeFileSync('research/accepted.json', JSON.stringify(rows, null, 1) + '\n');
console.log(`\nwrote ${out.length} tokens, ${rows.length} deployments; dropped ${dropped.length - (cand.excluded?.length ?? 0)} deployments, ${cand.excluded?.length ?? 0} assets excluded on purpose`);
