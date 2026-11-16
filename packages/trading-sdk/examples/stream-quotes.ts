// Live quotes over the wallet's websocket, with reconnection. Read-only: nothing here places, signs or cancels anything.
//   SP_WALLET_API_KEY=spw_live_… [SP_WALLET_BASE_URL=http://localhost:8650] node packages/trading-sdk/examples/stream-quotes.ts
// The key needs the scope `markets:read`; it travels in the Authorization header of the handshake, never in the URL.
// Node >= 22 (global WebSocket). In a browser, give `ticket` instead of a key: see docs/sdk/typescript.md, "Streaming".
// SP_WALLET_STREAM_QUOTES (default 5): how many quotes to print before the example stops; it also stops after 20 s.
import { SPWalletStream, StreamError } from '../src/index.ts';

const stream = new SPWalletStream({ baseUrl: process.env.SP_WALLET_BASE_URL ?? 'https://wallet.spboucher.ai' });   // the key: SP_WALLET_API_KEY
const wanted = Number(process.env.SP_WALLET_STREAM_QUOTES ?? 5);

stream.on('open', (hello) => console.log(`connected: connection ${hello.connId.slice(0, 8)}…, heartbeat every ${hello.heartbeatMs} ms`));
// the client reconnects by itself (exponential backoff with jitter) and subscribes again; the server then sends fresh snapshots
stream.on('close', (c) => console.log(`connection closed (${c.code}); ${c.willReconnect ? 'reconnecting' : 'not reconnecting'}`));
stream.on('error', (e) => console.log(`stream error: ${e.code}`));
stream.on('status', (s) => console.log(`venue ${s.venue}: ${s.status}`));

const giveUp = setTimeout(() => { console.log('no more quotes within 20 s (the venue may be unreachable)'); stream.close(); }, 20_000);
try {
  await stream.subscribe([{ type: 'status', id: 'hyperliquid' }, { type: 'quote', id: 'hyperliquid:BTC' }]);
  let n = 0;
  for await (const m of stream) {                       // every data message, in order; ends when the stream is closed
    if (m.type !== 'quote') continue;
    // prices and sizes are decimal STRINGS; `stale` says the quote is older than its freshness bound
    console.log(`quote ${m.id}: bid ${m.bid ?? 'n/a'} ask ${m.ask ?? 'n/a'} mark ${m.mark ?? 'n/a'}${m.stale ? ' (stale)' : ''}`);
    if (++n >= wanted) break;
  }
} catch (e) {
  // a refusal that a retry cannot fix (a key without markets:read, a revoked key, an unknown instrument) is a StreamError
  if (e instanceof StreamError) console.log(`refused: ${e.code}`);
  else throw e;
} finally {
  clearTimeout(giveUp);
  stream.close();
}
console.log('done');
