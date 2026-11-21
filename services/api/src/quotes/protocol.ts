/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/quotes/protocol.ts
 * Module           : quotes
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

// Quote engine — the wire protocol (version 1). JSON text frames; every number that is a price, a size or a rate is a
// canonical decimal STRING, never a float. The web client and the SDK import the TYPES of this file (erased at build);
// the value helpers both sides need are in shared.ts. Reference with examples: docs/V11-QUOTE-ENGINE.md.
import { z } from 'zod';
import { BOOK_DEPTHS, CANDLE_INTERVALS, CHANNEL_TYPES, QUOTE_PROTOCOL_VERSION } from './shared.ts';

const Dec = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
const Ms = z.number().int().nonnegative();
/** `venue:symbol`, the ids of the markets hub: `hyperliquid:BTC`, `hyperliquid:xyz:ANT`, `dydx:BTC-USD`, `gmx:BTC/USD [WBTC-USDC]`, `edgex:BTCUSD`, `spot:BTC`; `*` or a venue id for `status` */
export const ChannelId = z.string().min(1).max(80).regex(/^[A-Za-z0-9*._:\/\[\] -]+$/);

export const ChannelSchema = z.strictObject({
  type: z.enum(CHANNEL_TYPES), id: ChannelId,
  /** book only: levels per side (default 20) */ depth: z.union(BOOK_DEPTHS.map((d) => z.literal(d)) as [z.ZodLiteral<5>, z.ZodLiteral<10>, z.ZodLiteral<20>]).optional(),
  /** candle only (default 1m) */ interval: z.enum(CANDLE_INTERVALS).optional(),
});
export type Channel = z.infer<typeof ChannelSchema>;

// ------------------------------------------------------------------------------------------------ client → server
const ReqId = z.union([z.string().max(64), z.number().int()]).optional();
const V = z.literal(QUOTE_PROTOCOL_VERSION).optional();
export const ClientMessageSchema = z.discriminatedUnion('op', [
  z.strictObject({ v: V, op: z.literal('subscribe'), channels: z.array(ChannelSchema).min(1).max(200), reqId: ReqId }),
  z.strictObject({ v: V, op: z.literal('unsubscribe'), channels: z.array(ChannelSchema).min(1).max(200), reqId: ReqId }),
  z.strictObject({ v: V, op: z.literal('ping'), t: z.number().optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ------------------------------------------------------------------------------------------------ server → client
const v = z.literal(QUOTE_PROTOCOL_VERSION);
const LevelSchema = z.tuple([Dec, Dec]);
export const VENUE_STATES = ['connected', 'reconnecting', 'stale', 'down', 'idle'] as const;

export const QuoteSchema = z.object({
  v, type: z.literal('quote'), id: z.string(),
  bid: Dec.nullable(), bidSize: Dec.nullable(), ask: Dec.nullable(), askSize: Dec.nullable(),
  /** (bid + ask) / 2 when the source gives both sides, else the venue's own mid; null when it gives neither */
  mid: Dec.nullable(), mark: Dec.nullable(), index: Dec.nullable(), last: Dec.nullable(),
  /** per funding interval of the venue, as the venue publishes it (the markets hub normalises it per hour and per year) */
  funding: Dec.nullable(), openInterest: Dec.nullable(),
  /** fraction (0.01 = 1 %) and USD notional over 24 h, when the source publishes them */
  change24h: Dec.nullable(), volume24h: Dec.nullable(),
  /** the venue's own timestamp of the newest part of this quote; null when the venue gives none */
  venueTs: Ms.nullable(),
  /** when this server received the newest part */ recvTs: Ms,
  /** per channel, increasing by one for every quote the hub produced (a jump = conflated updates, never lost state) */ seq: Ms,
  /** e.g. `hyperliquid-ws`, `edgex-ws`, `dydx-ws`, `gmx-rest`, `coinbase-ws`, `coingecko-rest` */ source: z.string(),
  /** the server's verdict when the frame was built: older than the cadence of its source, or the venue is not connected */ stale: z.boolean(),
});
export type QuoteMsg = z.infer<typeof QuoteSchema>;

export const BookSchema = z.object({
  v, type: z.literal('book'), id: z.string(), depth: z.number().int(),
  /** `snapshot`: the whole book (replace); `delta`: changed prices only — a size of "0" removes the price */
  kind: z.enum(['snapshot', 'delta']), bids: z.array(LevelSchema), asks: z.array(LevelSchema),
  /** contiguous per channel: a delta applies only when `prevSeq` is the `seq` of the last message applied — otherwise resync */
  seq: Ms, prevSeq: Ms.nullable(),
  /** CRC-32 of the best 10 levels per side AFTER this message (shared.ts `bookChecksum`) */ checksum: z.number().int().nonnegative(),
  venueTs: Ms.nullable(), recvTs: Ms, source: z.string(), stale: z.boolean(),
});
export type BookMsg = z.infer<typeof BookSchema>;

export const TradeSchema = z.object({
  v, type: z.literal('trade'), id: z.string(),
  /** oldest first; `ts` is the venue's time of the trade */
  trades: z.array(z.object({ id: z.string(), price: Dec, size: Dec, side: z.enum(['buy', 'sell']), ts: Ms })),
  seq: Ms, recvTs: Ms, source: z.string(),
  /** true for the batch sent with `subscribed` (recent trades, already known to a client that was connected) */ snapshot: z.boolean().optional(),
});
export type TradeMsg = z.infer<typeof TradeSchema>;

export const CandleSchema = z.object({
  v, type: z.literal('candle'), id: z.string(), interval: z.enum(CANDLE_INTERVALS),
  /** open time of the bar; the bar is in progress until a bar with a later `ts` arrives */
  ts: Ms, open: Dec, high: Dec, low: Dec, close: Dec, volume: Dec,
  seq: Ms, recvTs: Ms, source: z.string(),
});
export type CandleMsg = z.infer<typeof CandleSchema>;

export const StatusSchema = z.object({
  v, type: z.literal('status'), venue: z.string(), status: z.enum(VENUE_STATES),
  /** when the venue entered this state */ since: Ms,
  /** age of the last message received from the venue; null before the first one */ ageMs: Ms.nullable(),
  /** `stream` (a websocket to the venue) or `poll` (REST polling) */ transport: z.enum(['stream', 'poll']), source: z.string(),
  detail: z.string().nullable(), ts: Ms,
});
export type StatusMsg = z.infer<typeof StatusSchema>;

const ChannelEcho = z.object({ type: z.enum(CHANNEL_TYPES), id: z.string(), depth: z.number().int().optional(), interval: z.string().optional() });
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ v, type: z.literal('hello'), connId: z.string(), heartbeatMs: Ms, serverTs: Ms,
    limits: z.object({ maxSubscriptions: Ms, maxFrameBytes: Ms, maxMessagesPerSec: Ms, idleTimeoutMs: Ms }) }),
  z.object({ v, type: z.literal('subscribed'), channel: ChannelEcho, key: z.string(), reqId: ReqId,
    /** a quote of this channel is stale once it is older than this (the client re-evaluates it with its own clock) */ staleAfterMs: Ms.nullable(),
    source: z.string().nullable(),
    /** the last known value, sent at once (a `quote`, a `book` snapshot, a `trade` batch, a `candle` or the `status` list); null when nothing was received yet */
    snapshot: z.unknown().nullable(), snapshotAgeMs: Ms.nullable() }),
  z.object({ v, type: z.literal('unsubscribed'), channel: ChannelEcho, key: z.string(), reqId: ReqId }),
  QuoteSchema, BookSchema, TradeSchema, CandleSchema, StatusSchema,
  /** trades the server did NOT send because this client is slow (quotes and books are conflated instead) */
  z.object({ v, type: z.literal('dropped'), channel: z.literal('trades'), id: z.string(), count: Ms, total: Ms }),
  z.object({ v, type: z.literal('heartbeat'), ts: Ms, subscriptions: Ms }),
  z.object({ v, type: z.literal('pong'), t: z.number().nullable(), ts: Ms }),
  z.object({ v, type: z.literal('error'), code: z.string(), message: z.string(), channel: ChannelEcho.optional(), reqId: ReqId }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type DataMessage = QuoteMsg | BookMsg | TradeMsg | CandleMsg | StatusMsg;

/** stable error codes of `error` frames */
export type QuoteErrorCode = 'bad_frame' | 'bad_message' | 'unsupported_version' | 'unknown_instrument' | 'unsupported_channel' | 'restricted' | 'too_many_subscriptions'
  | 'rate_limited' | 'upstream_unavailable' | 'internal';
