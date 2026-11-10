// TCP relay 127.0.0.1:<port> -> signer node. Runs as a system LaunchDaemon on the API node because macOS denies
// local-network access to PM2/LaunchAgent background processes (EHOSTUNREACH). It forwards bytes only: requests stay
// HMAC-authenticated end to end and the signer still verifies the passkey itself. The target is resolved per connection
// (mDNS name), so a DHCP renumbering does not break it.
import net from 'node:net';
const [host, port] = (process.env.SPW_RELAY_TARGET ?? '').split(':');
const listen = Number(process.env.SPW_RELAY_PORT ?? 8652);
if (!host || !port) { console.error('SPW_RELAY_TARGET=host:port required'); process.exit(2); }
net.createServer((c) => {
  const u = net.connect({ host, port: Number(port), timeout: 10000 });
  const end = (why) => { if (why) console.error(`${new Date().toISOString()} relay: ${why}`); c.destroy(); u.destroy(); };
  u.on('timeout', () => end('upstream timeout')).on('error', (e) => end(`upstream ${e.code ?? e.message}`));
  c.on('error', () => end()).setTimeout(30000, () => end());
  c.pipe(u); u.pipe(c);
}).listen(listen, '127.0.0.1', () => console.log(`signer relay 127.0.0.1:${listen} -> ${host}:${port}`));
