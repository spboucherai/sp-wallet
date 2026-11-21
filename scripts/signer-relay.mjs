/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/signer-relay.mjs
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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
