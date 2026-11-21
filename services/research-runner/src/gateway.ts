/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/research-runner/src/gateway.ts
 * Module           : services
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

// Model gateway of ONE research job: the only network door of the sandboxed agent.
//
// The sandbox profile lets the agent connect to one loopback port — this server — and nowhere else. The gateway:
//   - accepts only the model API's message endpoints (POST /v1/messages and /v1/messages/count_tokens); every other path is 404;
//   - requires the per-job placeholder key the runner put in the agent's environment (another local process cannot use it);
//   - REPLACES the credentials: the agent's headers are dropped and the runner's real model credential is added here, so the
//     agent process never holds it (its environment contains no secret at all);
//   - refuses requests that ask the model API for server-side tools that reach the web or run code elsewhere (web search,
//     web fetch, code execution, remote MCP servers): a job has no web access, whatever the agent's own tool list says;
//   - counts the tokens of every answer (usage in the JSON body or in the event stream) and refuses further requests once
//     the job's token budget is spent — the runner then kills the job. The agent cannot reset or bypass this counter.
// The upstream is one fixed origin (https://api.anthropic.com unless configured); the gateway never follows redirects and
// never connects anywhere the request names.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export interface GatewayOptions {
  /** origin of the model API, e.g. https://api.anthropic.com (tests: a local fake) */
  upstream: string;
  /** header carrying the runner's real credential, e.g. ['x-api-key', '...'] or ['authorization', 'Bearer ...']; null = none (fake upstream) */
  credential: [name: string, value: string] | null;
  /** placeholder the agent must present (given to it as ANTHROPIC_API_KEY) */
  jobKey: string;
  maxTokens: number;
  onLog?: (line: string) => void;
}
export interface GatewayUsage { requests: number; refused: number; inputTokens: number; outputTokens: number; cacheTokens: number; total: number; exhausted: boolean }

const ALLOWED = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const MAX_BODY = 32 * 1024 * 1024;
/** tool types executed by the model provider, outside the sandbox */
const SERVER_TOOL = /^(web_search|web_fetch|code_execution|mcp|computer|bash_code_execution|text_editor_code_execution)/;
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'x-api-key', 'authorization', 'proxy-authorization', 'cookie', 'accept-encoding', 'expect', 'keep-alive', 'upgrade']);
const DROP_RES = new Set(['connection', 'transfer-encoding', 'keep-alive', 'set-cookie', 'content-length']);

const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class ModelGateway {
  private server: Server | null = null;
  private readonly o: GatewayOptions;
  private readonly up: URL;
  readonly usage: GatewayUsage = { requests: 0, refused: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, total: 0, exhausted: false };
  port = 0;

  constructor(o: GatewayOptions) {
    this.o = o; this.up = new URL(o.upstream);
    if (this.up.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(this.up.hostname)) throw new Error('gateway: the upstream must be https (plain http is accepted for a loopback fake only)');
  }

  async start(): Promise<number> {
    this.server = createServer((req, res) => { this.handle(req, res).catch((e: Error) => { this.fail(res, 502, 'api_error', `gateway: ${e.message.slice(0, 120)}`); }); });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }
  async stop(): Promise<void> {
    const s = this.server; this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private fail(res: ServerResponse, status: number, type: string, message: string): void {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  }
  private count(u: unknown): void {
    if (!u || typeof u !== 'object') return;
    const n = (k: string): number => { const v = (u as Record<string, unknown>)[k]; return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; };
    this.usage.inputTokens += n('input_tokens'); this.usage.outputTokens += n('output_tokens');
    this.usage.cacheTokens += n('cache_creation_input_tokens') + n('cache_read_input_tokens');
    this.usage.total = this.usage.inputTokens + this.usage.outputTokens + this.usage.cacheTokens;
    if (this.usage.total >= this.o.maxTokens) this.usage.exhausted = true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]!;
    const refuse = (status: number, type: string, message: string): void => { this.usage.refused += 1; this.o.onLog?.(`gateway refused ${req.method} ${path.slice(0, 80)}: ${message}`); req.resume(); this.fail(res, status, type, message); };
    if (req.method !== 'POST' || !ALLOWED.has(path)) return refuse(404, 'not_found_error', 'this gateway only serves the model message endpoints');
    const presented = String(req.headers['x-api-key'] ?? '') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!same(presented, this.o.jobKey)) return refuse(401, 'authentication_error', 'unknown job key');
    if (this.usage.exhausted) return refuse(429, 'rate_limit_error', 'the token budget of this research job is spent');
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) return refuse(413, 'request_too_large', 'request body too large'); chunks.push(c as Buffer); }
    const body = Buffer.concat(chunks);
    let parsed: { tools?: unknown; mcp_servers?: unknown; stream?: unknown };
    try { parsed = JSON.parse(body.toString('utf8')) as typeof parsed; } catch { return refuse(400, 'invalid_request_error', 'the body is not JSON'); }
    if (parsed.mcp_servers !== undefined) return refuse(403, 'permission_error', 'remote MCP servers are not available to a research job');
    if (Array.isArray(parsed.tools)) for (const t of parsed.tools) { const type = (t as { type?: unknown } | null)?.type;
      if (typeof type === 'string' && SERVER_TOOL.test(type)) return refuse(403, 'permission_error', `the server-side tool "${type.slice(0, 40)}" is not available to a research job (no web access)`); }
    this.usage.requests += 1;

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP_REQ.has(k)) headers[k] = v;
    headers.host = this.up.host; headers['content-length'] = String(body.length); headers['accept-encoding'] = 'identity';
    if (this.o.credential) headers[this.o.credential[0]] = this.o.credential[1];
    const send = this.up.protocol === 'https:' ? httpsRequest : httpRequest;
    await new Promise<void>((resolve) => {
      const up = send({ protocol: this.up.protocol, hostname: this.up.hostname, port: this.up.port || undefined, method: 'POST', path: path + (req.url!.includes('?') ? req.url!.slice(req.url!.indexOf('?')) : ''), headers }, (ur) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !DROP_RES.has(k)) out[k] = v;
        res.writeHead(ur.statusCode ?? 502, out);
        const sse = String(ur.headers['content-type'] ?? '').includes('text/event-stream');
        let text = '';
        ur.on('data', (c: Buffer) => {
          res.write(c);
          if (path !== '/v1/messages') return;                         // count_tokens answers are not usage
          text += c.toString('utf8');
          if (!sse) { if (text.length > 8_000_000) text = text.slice(-8_000_000); return; }
          let i: number;
          while ((i = text.indexOf('\n')) >= 0) { const line = text.slice(0, i).trim(); text = text.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            try { const ev = JSON.parse(line.slice(5)) as { type?: string; message?: { usage?: unknown }; usage?: unknown };
              if (ev.type === 'message_start') this.count(ev.message?.usage);
              else if (ev.type === 'message_delta') this.count({ output_tokens: (ev.usage as { output_tokens?: number } | undefined)?.output_tokens }); } catch { /* not an event we count */ } }
        });
        ur.on('end', () => { if (!sse && path === '/v1/messages') { try { this.count((JSON.parse(text) as { usage?: unknown }).usage); } catch { /* an error body */ } } res.end(); resolve(); });
        ur.on('error', () => { res.end(); resolve(); });
      });
      up.on('error', (e) => { this.fail(res, 502, 'api_error', `the model API could not be reached: ${e.message.slice(0, 100)}`); resolve(); });
      up.setTimeout(10 * 60_000, () => up.destroy(new Error('timeout')));
      res.on('close', () => up.destroy());
      up.end(body);
    });
  }
}
