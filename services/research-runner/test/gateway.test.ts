// The model gateway of a job against a fake model API (a local HTTP server): the only paths, the per-job key, the
// credential swap (the agent never holds the real one), the refusal of web / code-execution server tools, token counting on
// plain and streamed answers, and the token budget.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelGateway } from '../src/gateway.ts';

let upstream: Server, upstreamUrl = '';
const seen: { path: string; headers: Record<string, unknown>; body: any }[] = [];
beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      if (req.url === '/v1/messages/count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":999}'); return; }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":10,"output_tokens":1}}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
        res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' }).end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 20, output_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});
afterAll(() => { upstream.close(); });

const make = async (maxTokens = 1000) => { const g = new ModelGateway({ upstream: upstreamUrl, credential: ['x-api-key', 'REAL-RUNNER-CREDENTIAL'], jobKey: 'job-placeholder', maxTokens }); await g.start(); return g; };
const call = (g: ModelGateway, path: string, body: unknown, o: { key?: string; method?: string; headers?: Record<string, string> } = {}) =>
  fetch(`http://127.0.0.1:${g.port}${path}`, { method: o.method ?? 'POST', headers: { 'content-type': 'application/json', 'x-api-key': o.key ?? 'job-placeholder', 'anthropic-version': '2023-06-01', ...(o.headers ?? {}) }, body: o.method === 'GET' ? undefined : JSON.stringify(body) });

describe('model gateway', () => {
  it('serves only the message endpoints, only to the job key', async () => {
    const g = await make();
    for (const [m, p] of [['GET', '/v1/messages'], ['POST', '/v1/files'], ['POST', '/v1/messages/batches'], ['GET', '/'], ['POST', '/api/v1/agents'], ['GET', '/v1/models']] as const)
      expect((await call(g, p, {}, { method: m })).status, `${m} ${p}`).toBe(404);
    expect((await call(g, '/v1/messages', { messages: [] }, { key: 'wrong' })).status).toBe(401);
    expect((await call(g, '/v1/messages', { messages: [] }, { key: '' })).status).toBe(401);
    expect(g.usage.requests).toBe(0);
    expect(g.usage.refused).toBe(8);
    expect(seen).toHaveLength(0);                                       // nothing reached the model API
    await g.stop();
  });

  it('replaces the credentials: the upstream sees the runner\'s, never the placeholder, a cookie or an authorization of the agent', async () => {
    const g = await make();
    const r = await call(g, '/v1/messages', { model: 'm', messages: [{ role: 'user', content: 'x' }] }, { headers: { authorization: 'Bearer agent-made-this-up', cookie: 'a=b', 'anthropic-beta': 'some-beta' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toBeNull();
    const last = seen.at(-1)!;
    expect(last.headers['x-api-key']).toBe('REAL-RUNNER-CREDENTIAL');
    expect(last.headers.authorization).toBeUndefined(); expect(last.headers.cookie).toBeUndefined();
    expect(last.headers['anthropic-beta']).toBe('some-beta'); expect(last.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.stringify(last)).not.toContain('job-placeholder');
    await g.stop();
  });

  it('refuses server-side tools that reach the web or run code elsewhere, and remote MCP servers; client tools pass', async () => {
    const g = await make(), before = seen.length;
    for (const type of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'mcp_toolset'])
      expect((await call(g, '/v1/messages', { tools: [{ type, name: 'x' }], messages: [] })).status, type).toBe(403);
    expect((await call(g, '/v1/messages', { mcp_servers: [{ url: 'https://evil.example' }], messages: [] })).status).toBe(403);
    expect((await call(g, '/v1/messages', 'not json')).status).toBe(200); // a JSON string is JSON; it has no tools
    expect(seen.length).toBe(before + 1);
    expect((await call(g, '/v1/messages', { tools: [{ name: 'Bash', description: 'd', input_schema: { type: 'object' } }, { type: 'custom', name: 'Read', input_schema: {} }], messages: [] })).status).toBe(200);
    await g.stop();
  });

  it('counts tokens of plain and streamed answers (count_tokens is free) and stops serving when the budget is spent', async () => {
    const g = await make(230);
    await (await call(g, '/v1/messages', { messages: [] })).text();
    expect(g.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, total: 25, exhausted: false });
    await (await call(g, '/v1/messages/count_tokens', { messages: [] })).text();
    expect(g.usage.total).toBe(25);
    const body = await (await call(g, '/v1/messages', { stream: true, messages: [] })).text();
    expect(body).toContain('message_stop');                             // the stream is passed through untouched
    expect(g.usage).toMatchObject({ inputTokens: 120, outputTokens: 56, cacheTokens: 50, total: 226, exhausted: false });
    await (await call(g, '/v1/messages', { messages: [] })).text();
    expect(g.usage).toMatchObject({ total: 251, exhausted: true });
    const refused = await call(g, '/v1/messages', { messages: [] });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/token budget of this research job is spent/);
    await g.stop();
  });

  it('only talks to an https upstream (plain http is for a loopback fake)', () => {
    expect(() => new ModelGateway({ upstream: 'http://api.example.com', credential: null, jobKey: 'k', maxTokens: 1 })).toThrow(/must be https/);
    expect(() => new ModelGateway({ upstream: 'https://api.anthropic.com', credential: null, jobKey: 'k', maxTokens: 1 })).not.toThrow();
  });
});
