// Read-only recorder of the public Hyperliquid websocket: l2Book + trades + bbo of BTC, 36 minutes, to a JSON-lines file. No key, no account, no exchange endpoint: only subscriptions and pings are sent. Usage: node record-tape.mjs <out.jsonl>; then build-tape.mjs.
import fs from 'node:fs';
const out = fs.createWriteStream('' + (process.argv[2] ?? 'raw.jsonl') + '', { flags: 'a' });
const END = Date.now() + 36 * 60_000;
function connect() {
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  ws.onopen = () => {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC' } }));
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } })); ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin: 'BTC' } }));
  };
  const ping = setInterval(() => { try { ws.send(JSON.stringify({ method: 'ping' })); } catch {} }, 30000);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.channel === 'l2Book' || m.channel === 'trades' || m.channel === 'bbo') out.write(JSON.stringify({ r: Date.now(), ...m }) + '\n');
    if (Date.now() > END) { clearInterval(ping); ws.close(); out.end(() => process.exit(0)); }
  };
  ws.onclose = () => { clearInterval(ping); if (Date.now() < END) { out.write(JSON.stringify({ r: Date.now(), channel: 'gap' }) + '\n'); setTimeout(connect, 1000); } };
  ws.onerror = () => {};
}
connect();
