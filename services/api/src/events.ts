/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/events.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT — the wallet's event stream: how web, macOS and iOS stay in step without re-reading everything on a timer.
//
// Every change a client may need to hear about is one row of `wallet_events` (db.ts `walletEvent`): a transfer changing
// state, a relay starting, confirmations, a deposit seen, a passkey or a session added or revoked, the address book, the
// settings, the emergency halt. Rows have an increasing id. A client remembers the last id it processed and either
//
//   GET /api/v1/events?after=<id>           the rows after that id (catch-up after a pause, a sleep, a lost connection)
//   GET /api/v1/events/stream               the same as Server-Sent Events, resumed with the standard `Last-Event-ID`
//                                           header (or `?after=`); `id:` on every event
//
// Rules a client can rely on:
//  - ids only grow; an event is delivered at least once; processing the same id twice must be harmless (they are facts
//    about state, not commands — a client re-reads the object named by `ref` rather than applying a delta);
//  - when the id a client resumes from is older than what is kept (RETENTION_DAYS) or newer than the newest id (a restored
//    database), the first event is `reset`: forget the position, reload everything, continue from the id it carries;
//  - an event never carries a balance or a state the chain did not give: it says "look", the read routes say what is true;
//  - the stream ends by itself after ten minutes; the client reconnects through the session check.
//
// Nothing here signs, and nothing here is needed for correctness: a client that only polls still sees the same state.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserError } from './config.ts';
import { sql } from './db.ts';

export const RETENTION_DAYS = 30, MAX_STREAMS = 12, STREAM_MAX_MS = 10 * 60_000, PAGE = 500, POLL_MS = 5_000;
/** Audit types that are also wallet events (db.ts `audit` mirrors them). `transfer.*` is written by `move` itself, with more detail. */
export const MIRRORED = /^(deposit\.|device\.|credentials\.|sessions?\.|login\.ok$|addressbook\.|settings\.|halt\.|owner\.setup$|security\.)/;

export interface WalletEvent { id: number; at: string; type: string; ref: string | null; data: Record<string, unknown> }
type Row = { id: string; at: Date; type: string; ref: string | null; data: Record<string, unknown> };
const shape = (r: Row): WalletEvent => ({ id: Number(r.id), at: r.at.toISOString(), type: r.type, ref: r.ref, data: r.data });

export async function latestEventId(): Promise<number> { const [r] = await sql<{ id: string | null }[]>`select max(id) as id from wallet_events`; return Number(r?.id ?? 0); }
async function oldestEventId(): Promise<number> { const [r] = await sql<{ id: string | null }[]>`select min(id) as id from wallet_events`; return Number(r?.id ?? 0); }
export async function eventsAfter(after: number, limit = PAGE): Promise<WalletEvent[]> {
  return (await sql<Row[]>`select id, at, type, ref, data from wallet_events where id > ${after} order by id asc limit ${limit}`).map(shape);
}
/** Can a client resume from `after`? No when rows it has not seen were pruned, or when its position is ahead of the log. */
export async function resumable(after: number): Promise<boolean> {
  if (after === 0) return true;
  const [latest, oldest] = [await latestEventId(), await oldestEventId()];
  return after <= latest && (oldest === 0 || after >= oldest - 1);
}
export async function pruneEvents(): Promise<number> {
  // the newest row is always kept: it is the position a quiet wallet's clients hold
  return (await sql`delete from wallet_events where at < now() - ${RETENTION_DAYS} * interval '1 day' and id < (select max(id) from wallet_events)`).count;
}

// one LISTEN for the whole process; every open stream is woken by it (and by a slow poll, in case a notification is lost)
const wake = new Set<() => void>();
let listening: Promise<unknown> | null = null;
const listen = (): void => { listening ??= sql.listen('wallet_events', () => { for (const f of wake) f(); }).catch(() => { listening = null; }); };

const After = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export function eventRoutes(app: FastifyInstance): void {
  app.get('/api/v1/events', async (req) => {
    const q = z.object({ after: After.default(0), limit: z.coerce.number().int().min(1).max(PAGE).default(PAGE) }).parse(req.query);
    if (!(await resumable(q.after))) return { reset: true, events: [], latest: await latestEventId(), more: false };
    const events = await eventsAfter(q.after, q.limit);
    return { reset: false, events, latest: await latestEventId(), more: events.length === q.limit };
  });

  let streams = 0;
  app.get('/api/v1/events/stream', async (req, reply) => {
    const header = req.headers['last-event-id'], asked = (req.query as { after?: string }).after;
    const parsed = After.safeParse(typeof header === 'string' && header !== '' ? header : asked ?? '');
    // no position given: start from now (a client that wants the past asks for it with ?after=0)
    let cursor = parsed.success && (header !== undefined || asked !== undefined) ? parsed.data : await latestEventId();
    if (streams >= MAX_STREAMS) throw new UserError('too_many_streams', `at most ${MAX_STREAMS} event streams at once`, 429);
    const reset = !(await resumable(cursor));
    if (reset) cursor = await latestEventId();
    streams += 1;
    listen();
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (chunk: string): void => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(chunk); };
    write(`retry: 3000\n\n`);
    // `hello` carries no id on purpose: it must not move a resuming client's position before the catch-up is delivered
    write(reset ? `id: ${cursor}\nevent: reset\ndata: ${JSON.stringify({ latest: cursor })}\n\n` : `event: hello\ndata: ${JSON.stringify({ from: cursor })}\n\n`);
    let busy = false, again = false, done = false;
    const pump = (): void => {
      if (done) return;
      if (busy) { again = true; return; }
      busy = true;
      void (async () => {
        for (;;) {
          const batch = await eventsAfter(cursor);
          for (const e of batch) { write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); cursor = e.id; }
          if (batch.length < PAGE || done) break;
        }
      })().catch(() => {}).finally(() => { busy = false; if (again) { again = false; pump(); } });
    };
    wake.add(pump);
    const beat = setInterval(() => write(': keep-alive\n\n'), 15_000), poll = setInterval(pump, POLL_MS), stop = setTimeout(() => end(), STREAM_MAX_MS);
    beat.unref(); poll.unref(); stop.unref();
    const end = (): void => { if (done) return; done = true; streams -= 1; wake.delete(pump); clearInterval(beat); clearInterval(poll); clearTimeout(stop); if (!reply.raw.writableEnded) reply.raw.end(); };
    req.raw.on('close', end); reply.raw.on('close', end); reply.raw.on('error', end);
    pump();
  });
}
