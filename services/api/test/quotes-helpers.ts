/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/quotes-helpers.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// Scripted upstreams and sockets for the quote engine tests. No network.
import { readFileSync } from 'node:fs';
import type { FeedSpec, Frame, UpStatus, Upstream, UpstreamSink } from '../src/quotes/hub.ts';
import type { DataMessage } from '../src/quotes/protocol.ts';
import type { Level } from '../src/quotes/shared.ts';

export interface FakeFeed { spec: FeedSpec; sink: UpstreamSink; onStatus: (s: UpStatus, d?: string) => void; open: boolean }
export interface FakeUp { up: Upstream; feeds: FakeFeed[]; log: string[]; open(): FakeFeed[]; feed(kind: string, symbol: string): FakeFeed; status(s: UpStatus, d?: string): void; knownCalls: number; closed: boolean }
/** a venue the test drives by hand: `feed('ticker', 'BTC').sink.quote(…)`, `status('reconnecting')` */
export function fakeUpstream(venue: string, o: { symbols?: string[]; bbo?: boolean; book?: boolean; staleAfterMs?: number; transport?: 'stream' | 'poll'; known?: (s: string) => Promise<boolean>; failOpen?: (f: FeedSpec) => boolean } = {}): FakeUp {
  const feeds: FakeFeed[] = [], log: string[] = [];
  const f: FakeUp = {
    feeds, log, knownCalls: 0, closed: false,
    open: () => feeds.filter((x) => x.open),
    feed: (kind, symbol) => { const x = feeds.find((y) => y.open && y.spec.kind === kind && y.spec.symbol === symbol); if (!x) throw new Error(`no open ${venue} feed ${kind} ${symbol}`); return x; },
    status: (s, d) => { for (const x of f.open()) x.onStatus(s, d); },
    up: {
      venue,
      feedsFor: (type, symbol, interval) => (type === 'quote' ? [{ kind: 'ticker', symbol }, ...(o.bbo ? [{ kind: 'bbo' as const, symbol }] : [])] : type === 'book' ? (o.book === false ? [] : [{ kind: 'book', symbol }]) : type === 'trades' ? [{ kind: 'trades', symbol }] : [{ kind: 'candle', symbol, interval }]),
      info: () => ({ source: `${venue}-${o.transport === 'poll' ? 'rest' : 'ws'}`, transport: o.transport ?? 'stream', staleAfterMs: o.staleAfterMs ?? 15_000 }),
      known: async (symbol) => { f.knownCalls += 1; return o.known ? o.known(symbol) : (o.symbols ?? ['BTC', 'ETH', 'SOL']).includes(symbol); },
      open(spec, sink, onStatus) {
        if (o.failOpen?.(spec)) throw new Error(`${venue} refuses ${spec.kind}`);
        const x: FakeFeed = { spec, sink, onStatus, open: true };
        feeds.push(x); log.push(`open ${spec.kind} ${spec.symbol}`);
        return () => { x.open = false; log.push(`close ${spec.kind} ${spec.symbol}`); };
      },
      stats: () => ({ open: f.open().length }),
      close: () => { f.closed = true; },
    },
  };
  return f;
}

export const collect = (): { frames: Frame[]; msgs: DataMessage[]; on: (f: Frame) => void; of<T extends DataMessage['type']>(type: T): Extract<DataMessage, { type: T }>[] } => {
  const frames: Frame[] = [], msgs: DataMessage[] = [];
  return { frames, msgs, on: (f) => { frames.push(f); msgs.push(f.msg); }, of: (type) => msgs.filter((m) => m.type === type) as never };
};
export const L = (...rows: [string, string][]): Level[] => rows;

/** a WHATWG-style websocket the test drives: `open()`, `serve(frame)`, `drop()` */
export class ScriptedSocket {
  static instances: ScriptedSocket[] = [];
  static reset(): void { ScriptedSocket.instances = []; }
  static get last(): ScriptedSocket { return ScriptedSocket.instances[ScriptedSocket.instances.length - 1]!; }
  readonly sent: any[] = []; closed = false;
  onopen: ((ev: unknown) => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null; onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { ScriptedSocket.instances.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.({}); }
  serve(m: unknown): void { this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) }); }
  drop(): void { this.onclose?.({}); }
}

export interface Recording { recordedAt: string; url: string; sent: any[]; messages: any[]; counts: Record<string, number> }
export const recording = (name: string): Recording => JSON.parse(readFileSync(new URL(`./fixtures/quotes/${name}.json`, import.meta.url), 'utf8'));
