// Reads research/candidates.json, verifies every deployment ON-CHAIN, cross-checks CoinGecko when research/cg.json is present,
// and writes packages/core/src/tokens.ts. A deployment that fails any check is dropped and reported — never silently kept.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { decodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, hexToNumber, hexToString } from 'viem';

const RPC: Record<string, string> = { ethereum: 'https://ethereum-rpc.publicnode.com', base: 'https://mainnet.base.org', arbitrum: 'https://arb1.arbitrum.io/rpc', polygon: 'https://polygon-bor-rpc.publicnode.com',
  optimism: 'https://mainnet.optimism.io', bsc: 'https://bsc-dataseed.bnbchain.org', avalanche: 'https://api.avax.network/ext/bc/C/rpc', hyperevm: 'https://rpc.hyperliquid.xyz/evm', solana: 'https://api.mainnet-beta.solana.com' };
const CG: Record<string, string> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum-one', polygon: 'polygon-pos', optimism: 'optimistic-ethereum', bsc: 'binance-smart-chain', avalanche: 'avalanche', hyperevm: 'hyperevm', solana: 'solana' };
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** on-chain symbol() values that legitimately differ from the ticker (checked by hand, with the reason) */
const SYMBOL_ALIAS: Record<string, string[]> = { USDT: ['USDT', 'USD₮', 'USDt'], RENDER: ['RENDER', 'RNDR'], WBTC: ['WBTC'], USDe: ['USDe'] };

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json() as any;
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (k === 3) throw e; await new Promise((r) => setTimeout(r, 1200 * (k + 1))); }
  }
}
const cand = JSON.parse(readFileSync('research/candidates.json', 'utf8'));
const cg: Record<string, any> = existsSync('research/cg.json') ? JSON.parse(readFileSync('research/cg.json', 'utf8')) : {};
const cgBySymbol = new Map<string, any>(Object.values(cg).filter((v: any) => v.platforms).map((v: any) => [String(v.symbol).toUpperCase(), v]));
const out: any[] = [], dropped: string[] = [];
for (const t of cand.tokens) {
  const deployments: Record<string, any> = {}; let baseDec: number | null = null;
  for (const [net, raw] of Object.entries(t.d as Record<string, string>)) {
    const tag = `${t.symbol}@${net}`;
    try {
      const second = cgBySymbol.get(t.symbol.toUpperCase())?.platforms?.[CG[net]!]?.contract_address;
      if (!second) throw new Error('no second source (CoinGecko) for this network');
      if (net === 'solana') {
        if (second !== raw) throw new Error(`second source differs: ${second}`);
        const a = (await rpc(RPC.solana!, 'getAccountInfo', [raw, { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
        if (!a || a.data?.parsed?.type !== 'mint' || ![TOKEN, TOKEN22].includes(a.owner)) throw new Error('not an SPL mint');
        const ext = (a.data.parsed.info.extensions ?? []).map((e: any) => e.extension);
        // Token-2022 mints with a transfer hook or a non-zero transfer fee change what "transfer" means: refuse them
        const fee = (a.data.parsed.info.extensions ?? []).find((e: any) => e.extension === 'transferFeeConfig')?.state;
        if (ext.includes('transferHook') && (a.data.parsed.info.extensions.find((e: any) => e.extension === 'transferHook').state.programId)) throw new Error('mint has an active transfer hook');
        if (fee && (fee.newerTransferFee?.transferFeeBasisPoints || fee.olderTransferFee?.transferFeeBasisPoints)) throw new Error('mint charges a transfer fee');
        if (ext.includes('nonTransferable')) throw new Error('non-transferable mint');
        deployments[net] = { address: raw, decimals: a.data.parsed.info.decimals, ...(a.owner === TOKEN22 ? { program: 'token2022' } : {}) };
        console.log('ok ', tag, raw, 'dec', a.data.parsed.info.decimals, a.owner === TOKEN22 ? `token2022 [${ext.join(',')}]` : 'token');
      } else {
        const addr = getAddress(raw.toLowerCase());
        if (second.toLowerCase() !== addr.toLowerCase()) throw new Error(`second source differs: ${second}`);
        const code = await rpc(RPC[net]!, 'eth_getCode', [addr, 'latest']);
        if (!code || code === '0x') throw new Error('no contract code');
        const dec = hexToNumber(await rpc(RPC[net]!, 'eth_call', [{ to: addr, data: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) }, 'latest']));
        const sraw = await rpc(RPC[net]!, 'eth_call', [{ to: addr, data: encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' }) }, 'latest']);
        let sym: string; try { sym = decodeAbiParameters([{ type: 'string' }], sraw)[0]; } catch { sym = hexToString(sraw, { size: 32 }); }
        const allowed = (SYMBOL_ALIAS[t.symbol] ?? [t.symbol]).map((s) => s.toUpperCase());
        if (!allowed.includes(sym.toUpperCase())) throw new Error(`on-chain symbol is "${sym}"`);
        deployments[net] = { address: addr, decimals: dec, ...(sym !== t.symbol ? { onchainSymbol: sym } : {}) };
        console.log('ok ', tag, addr, 'dec', dec, sym);
      }
      baseDec ??= deployments[net].decimals;
    } catch (e) { dropped.push(`${tag}: ${(e as Error).message}`); console.log('DROP', tag, (e as Error).message); }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (Object.keys(deployments).length) {
    const counts = new Map<number, number>(); for (const d of Object.values(deployments)) counts.set(d.decimals, (counts.get(d.decimals) ?? 0) + 1);
    const main = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    for (const d of Object.values(deployments)) if (d.decimals === main) delete d.decimals;
    out.push({ symbol: t.symbol, name: t.name, decimals: main, source: t.source, deployments });
  }
}
const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;
const body = out.map((t) => `  // ${t.source}\n  { symbol: ${q(t.symbol)}, name: ${q(t.name)}, decimals: ${t.decimals}, deployments: {\n${Object.entries(t.deployments).map(([n, d]: [string, any]) =>
  `    ${n}: { address: ${q(d.address)}${d.decimals !== undefined ? `, decimals: ${d.decimals}` : ''}${d.program ? `, program: ${q(d.program)}` : ''}${d.onchainSymbol ? `, onchainSymbol: ${q(d.onchainSymbol)}` : ''} },`).join('\n')}\n  } },`).join('\n');
writeFileSync('packages/core/src/tokens.ts', `// GENERATED by scripts/gen-tokens.mts on ${new Date().toISOString().slice(0, 10)} from research/candidates.json — do not edit by hand.
// Inclusion rule: issuer documentation states the address, CoinGecko's contract list agrees, and the contract's own
// symbol()/decimals() (EVM) or mint owner program/decimals (Solana) match. The API re-checks the on-chain part at every start.
export interface TokenDef {
  symbol: string; name: string; decimals: number;
  /** network id -> deployment. \`decimals\` overrides when a chain differs. \`onchainSymbol\`: what the contract itself returns when it is not the ticker. */
  deployments: Record<string, { address: string; decimals?: number; program?: 'token' | 'token2022'; onchainSymbol?: string }>;
}
export const TOKENS: TokenDef[] = [
${body}
];
`);
writeFileSync('research/dropped.txt', dropped.join('\n') + '\n');
console.log(`\nwrote ${out.length} tokens, ${out.reduce((s, t) => s + Object.keys(t.deployments).length, 0)} deployments; dropped ${dropped.length}`);
