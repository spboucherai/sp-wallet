// Fixture replay for the venue adapters: recorded HTTP exchanges served through an injected fetch.
import { readFileSync } from 'node:fs';

export interface HttpFixture { recordedAt: string; url: string; status: number; text: string; trimmed?: string }
export interface WsFixture { recordedAt: string; url: string; sent: unknown[]; messages: Record<string, unknown>[] }
export const fx = (venue: string, name: string): HttpFixture => JSON.parse(readFileSync(new URL(`./fixtures/${venue}/${name}.json`, import.meta.url), 'utf8'));
export const wsFx = (venue: string, name: string): WsFixture => JSON.parse(readFileSync(new URL(`./fixtures/${venue}/${name}.json`, import.meta.url), 'utf8'));

export type Route = [match: string | RegExp, answer: HttpFixture | { status: number; text: string } | (() => Response | Promise<Response>)];
/**
 * fetch replacement: the first route whose pattern matches the URL answers. A string pattern matches when the URL contains it.
 * `patch` rewrites the parsed JSON body of a matched fixture (to test malformed answers).
 */
export function replay(routes: Route[], patch?: (url: string, body: any) => unknown) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    for (const [match, answer] of routes) {
      if (typeof match === 'string' ? !String(url).includes(match) : !match.test(String(url))) continue;
      if (typeof answer === 'function') return answer();
      let text = answer.text;
      if (patch && answer.status === 200) { const p = patch(String(url), JSON.parse(text)); if (p !== undefined) text = typeof p === 'string' ? p : JSON.stringify(p); }
      return new Response(text, { status: answer.status, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`no fixture route for ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Scripted WebSocket: the test drives `open`, `serve` (a server message), `drop` (connection lost). */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  static reset(): void { FakeSocket.instances = []; }
  static get last(): FakeSocket { return FakeSocket.instances[FakeSocket.instances.length - 1]!; }
  readonly url: string;
  readonly sent: any[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.({}); }
  serve(message: unknown): void { this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) }); }
  drop(): void { this.onclose?.({}); }
  subscriptions(): string[] { return this.sent.filter((m) => m.type === 'subscribe').map((m) => `${m.channel}|${m.id ?? ''}`); }
}

// the shared models name their schemas XSchema; the venue tests use short names
export { AccountStateSchema as accountState, BookSchema as book, CandleSchema as candle, FillSchema as fill, FundingPaymentSchema as fundingPayment, InstrumentSchema as instrument,
  OrderSchema as order, PositionSchema as position, PublicTradeSchema as publicTrade, TickerSchema as ticker } from '../src/index.ts';
