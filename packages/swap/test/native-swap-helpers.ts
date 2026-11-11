// Shared harness for the THORChain / Maya adapter tests: replays answers recorded from the live APIs
// (test/fixtures/<id>/*.json, written by test/fixtures/record.mjs) through the real HTTP client.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { httpClient, type AssetRef, type ProviderContext, type SwapProvider, type SwapQuoteRequest } from '../src/index.ts';
import { fromProtocolAmount, type MappedAsset } from '../src/providers/thorchain.ts';

export interface Fixture { recordedAt: string; url: string; status: number; body: any }
export const loadFixture = (dir: string, name: string): Fixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${dir}/${name}.json`, import.meta.url)), 'utf8')) as Fixture;
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type NativeProvider = SwapProvider & { assets: Map<string, MappedAsset> };
const SENDERS: Record<string, string> = {
  evm: '0x000000000000000000000000000000000000dEaD', btc: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', bch: 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
  sol: '11111111111111111111111111111112', xrpl: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', tron: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', cosmos: 'cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a',
};

/** The wallet request that produces exactly the recorded quote URL. */
export function requestFor(p: NativeProvider, fx: Fixture, families: Record<string, string>): SwapQuoteRequest {
  const u = new URL(fx.url).searchParams;
  const find = (notation: string) => { const a = [...p.assets.values()].find((x) => x.notation === notation); if (!a) throw new Error(`fixture asset ${notation} is not mapped`); return a; };
  const from = find(u.get('from_asset')!), to = find(u.get('to_asset')!);
  return { from: from.ref, to: to.ref, amountIn: fromProtocolAmount(BigInt(u.get('amount')!), from.decimals), sender: SENDERS[families[from.ref.network]!] ?? 'SENDER',
    recipient: u.get('destination')!, slippageBps: Number(u.get('liquidity_tolerance_bps')) };
}

export interface Replay { ctx: ProviderContext; calls: string[]; inbound: Fixture }
/** A context whose HTTP client answers `/inbound_addresses` and `/quote/swap` from fixtures; `now` is the recording time. */
export function replay(id: string, dir: string, quote: Fixture | ((url: string) => Response | Promise<Response>), opts: { inbound?: Fixture | ((url: string) => Response); now?: number; signal?: AbortSignal } = {}): Replay {
  const inbound = typeof opts.inbound === 'function' ? loadFixture(dir, 'inbound_addresses') : clone(opts.inbound ?? loadFixture(dir, 'inbound_addresses'));
  const calls: string[] = [];
  const json = (f: Fixture) => new Response(typeof f.body === 'string' ? f.body : JSON.stringify(f.body), { status: f.status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/inbound_addresses')) return typeof opts.inbound === 'function' ? opts.inbound(url) : json(inbound);
    if (url.includes('/quote/swap?')) return typeof quote === 'function' ? quote(url) : json(quote);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const at = opts.now ?? Date.parse(typeof quote === 'function' ? inbound.recordedAt : quote.recordedAt);
  return { ctx: { signal: opts.signal ?? new AbortController().signal, http: httpClient(id, fetchImpl), now: () => at }, calls, inbound };
}
export const quoteCall = (r: Replay) => r.calls.find((u) => u.includes('/quote/swap?'));
export const sameRef = (a: AssetRef, b: AssetRef) => a.network === b.network && a.asset.toLowerCase() === b.asset.toLowerCase();
