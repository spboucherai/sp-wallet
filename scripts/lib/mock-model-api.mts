/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/lib/mock-model-api.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// A scripted stand-in for the model API (POST /v1/messages, plain or streamed), for running the REAL coding-agent CLI
// without spending any model quota: the "model" plays a fixed list of turns (text and tool calls), whatever it is asked.
// Used by scripts/sim-research-job.mts --claude-mock. No network, no key.
import { createServer, type Server } from 'node:http';

export type MockBlock = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> };
export interface MockModel { url: string; server: Server; requests: { path: string; tools: string[]; system: string; keyHeader: string; stream: boolean }[]; close(): void }

export async function startMockModel(turns: MockBlock[][]): Promise<MockModel> {
  const requests: MockModel['requests'] = [];
  let turn = 0, n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* empty */ }
      const tools = Array.isArray(body.tools) ? body.tools.map((t: any) => String(t?.name ?? t?.type)) : [];
      const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? '').join('\n') : '';
      requests.push({ path: req.url ?? '', tools, system, keyHeader: String(req.headers['x-api-key'] ?? ''), stream: body.stream === true });
      if (req.url?.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1000}'); return; }
      // the scripted conversation is played to the requests that carry tools (the agent loop); side requests get a short text
      const blocks: MockBlock[] = tools.length ? (turns[turn++] ?? [{ type: 'text', text: 'Done.' }]) : [{ type: 'text', text: 'ok' }];
      const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', id = `msg_mock_${++n}`;
      const content = blocks.map((b, i) => (b.type === 'text' ? b : { type: 'tool_use', id: `toolu_mock_${n}_${i}`, name: b.name, input: b.input }));
      const usage = { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model ?? 'mock', content, stop_reason: stop, stop_sequence: null, usage })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = (type: string, data: unknown): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`); };
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      content.forEach((b: any, index) => {
        if (b.type === 'text') { ev('content_block_start', { index, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }); }
        else { ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }); ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }); }
        ev('content_block_stop', { index });
      });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      ev('message_stop', {});
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, requests, close: () => { server.closeAllConnections(); server.close(); } };
}
