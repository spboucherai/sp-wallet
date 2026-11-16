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
