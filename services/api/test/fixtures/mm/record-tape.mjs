// Read-only recorder: public Hyperliquid WS, l2Book + trades for BTC. No auth, no exchange endpoint.
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
