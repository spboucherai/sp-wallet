/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/examples/webhook-receiver.ts
 * Module           : trading-sdk
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

// Minimal webhook receiver (Node): verifies X-SPW-Signature over the RAW body, then handles the event.
//   SP_WALLET_WEBHOOK_SECRET=… node packages/trading-sdk/examples/webhook-receiver.ts
import { createServer } from 'node:http';
import { constructWebhookEvent, WebhookVerificationError } from '../src/index.ts';

const secret = process.env.SP_WALLET_WEBHOOK_SECRET;
if (!secret) { console.error('set SP_WALLET_WEBHOOK_SECRET (shown once when the webhook endpoint is created)'); process.exit(1); }
const seen = new Set<string>(); // delivery is at-least-once: deduplicate on the event id (use a durable store in production)

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      try {
        const event = await constructWebhookEvent({ secret, timestamp: req.headers['x-spw-timestamp'] as string | undefined, signature: req.headers['x-spw-signature'] as string | undefined, body: Buffer.concat(chunks) });
        if (!seen.has(event.id)) { seen.add(event.id); console.log(`${event.event} ${event.id}`, event.data); }
        res.writeHead(200).end('ok');
      } catch (e) {
        res.writeHead(e instanceof WebhookVerificationError ? 400 : 500).end();
      }
    })();
  });
}).listen(Number(process.env.PORT ?? 8787), () => console.log('listening'));
