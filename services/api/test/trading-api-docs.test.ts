/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/trading-api-docs.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// The reference of the trading API — pure parts (no database, no server): the worked examples against the contract, the
// error catalogue against the codes the operations declare, the SDK calls against the two SDKs, the facts the guide quotes
// against the constants of the code, and the rendered page (every operation, with an example; nothing a CSP of
// `script-src 'self'` would block; nothing fetched from another origin). The served routes are tested in trading-api.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyWebhook, webhookSignature } from '../src/alerts/webhook.ts';
import { ERROR_CATALOG, MANDATE_DENY_DOCS, ORDER_STATE_DOCS, SCOPE_DOCS } from '../src/trading-api/error-catalog.ts';
import { ERROR_EXAMPLES, EXAMPLES } from '../src/trading-api/examples.ts';
import { DOCS_PATH, FACTS, FAKE_KEY, GUIDE, WEBHOOK_EXAMPLE } from '../src/trading-api/guide.ts';
import { parseToken } from '../src/trading-api/key-model.ts';
import { buildOpenApi, codeSamples, exampleUrl } from '../src/trading-api/openapi.ts';
import { highlightJson, mdToHtml, REFERENCE_JS, referenceHtml, referenceMarkdown, referenceModel, typeOf } from '../src/trading-api/reference.ts';
import { ErrorSchema, errorsOf, MANDATE_DENY_REASONS, OPERATIONS, ORDER_STATES, SCOPES, TRADING_PREFIX } from '../src/trading-api/spec.ts';
import { SPWallet } from '../../../packages/trading-sdk/src/index.ts';
import { REPO_ROOT } from './test-db.ts';

const src = (p: string): string => readFileSync(`${REPO_ROOT}/${p}`, 'utf8');
const html = referenceHtml(), md = referenceMarkdown();

describe('worked examples (examples.ts)', () => {
  it('every operation has exactly one example, and no example names an operation that does not exist', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(OPERATIONS.map((o) => o.id).sort());
  });
  it('every example request passes the operation\'s own schemas, and every example answer its response schema', () => {
    for (const op of OPERATIONS) {
      const ex = EXAMPLES[op.id]!;
      const check = (what: string, schema: { safeParse(v: unknown): { success: boolean; error?: unknown } } | undefined, value: unknown) => {
        if (!schema) { expect(value, `${op.id}: ${what} given, and the operation takes none`).toBeUndefined(); return; }
        const r = schema.safeParse(value);
        expect(r.success, `${op.id} ${what}: ${JSON.stringify((r.error as { issues?: unknown[] } | undefined)?.issues?.slice(0, 2))}`).toBe(true);
      };
      check('params', op.params, ex.params);
      check('query', op.query, ex.query === undefined ? (op.query ? {} : undefined) : Object.fromEntries(Object.entries(ex.query).map(([k, v]) => [k, String(v)])));   // a query string carries strings
      check('body', op.body, ex.body);
      check('response', op.response, ex.response);
    }
  });
  it('the URL of every example is a URL of its route', () => {
    for (const op of OPERATIONS) {
      const url = exampleUrl(op, EXAMPLES[op.id]!), path = decodeURIComponent(url.split('?')[0]!);
      const route = new RegExp(`^${TRADING_PREFIX}${op.path.replace(/:[A-Za-z]+/g, '[^?]+')}$`);
      expect(path, op.id).toMatch(route);
      expect(url, `${op.id}: a space or a quote in a URL`).not.toMatch(/[\s"']/);
    }
  });
  it('a curl sample carries the Authorization header, an Idempotency-Key exactly when the operation requires one, and the body as JSON', () => {
    for (const op of OPERATIONS) {
      const ex = EXAMPLES[op.id]!, curl = codeSamples(op, ex)[0]!.source;
      expect(curl).toContain('-H "Authorization: Bearer $SP_WALLET_API_KEY"');
      expect(curl.includes('Idempotency-Key'), op.id).toBe(op.idempotent === true);
      expect(curl.includes(` -X ${op.method}`), op.id).toBe(op.method !== 'GET');
      if (ex.body !== undefined) expect(JSON.parse(/-d '(.*)'$/s.exec(curl)![1]!)).toEqual(ex.body);
      else expect(curl).not.toContain(' -d ');
    }
  });
  it('every SDK call of a sample is a method of the TypeScript client and of the Python client', () => {
    const py = src('sdk/python/src/sp_wallet/_client.py'), pyMethods = new Set([...py.matchAll(/^    def ([a-z_]+)\(/gm)].map((m) => m[1]!));
    for (const op of OPERATIONS) {
      const ex = EXAMPLES[op.id]!, ts = [...ex.ts.matchAll(/client\.([A-Za-z]+)\(/g)].map((m) => m[1]!), p = [...ex.py.matchAll(/client\.([a-z_]+)\(/g)].map((m) => m[1]!);
      expect(ts.length, `${op.id}: no TypeScript call`).toBeGreaterThan(0);
      expect(p.length, `${op.id}: no Python call`).toBeGreaterThan(0);
      for (const m of ts) expect(typeof (SPWallet.prototype as unknown as Record<string, unknown>)[m], `${op.id}: SPWallet.${m} (TypeScript)`).toBe('function');
      for (const m of p) expect(pyMethods.has(m), `${op.id}: SPWallet.${m} (Python)`).toBe(true);
    }
  });
  it('the recorded error answers are errors of the contract', () => {
    const known = new Set(OPERATIONS.flatMap((o) => errorsOf(o).map((e) => `${e.status} ${e.code}`)));
    known.add('404 not_found');
    for (const [name, e] of Object.entries(ERROR_EXAMPLES)) {
      expect(ErrorSchema.safeParse(e.body).success, name).toBe(true);
      expect(known.has(`${e.status} ${(e.body as { error: string }).error}`), `${name}: ${e.status} ${(e.body as { error: string }).error}`).toBe(true);
    }
  });
  it('no example carries a real key: the only token is the fake one, and it parses as a token so that it looks like one', () => {
    expect(parseToken(FAKE_KEY)).not.toBeNull();
    for (const text of [html, md, JSON.stringify(buildOpenApi())]) {
      const tokens = [...new Set(text.match(/spw_live_spk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/g) ?? [])];
      expect(tokens.every((t) => t === FAKE_KEY), tokens.join(' ')).toBe(true);
      expect(text).not.toMatch(/whsec_(?!EXAMPLE_ONLY)[A-Za-z0-9_-]{20,}/);
    }
  });
});

describe('error catalogue (error-catalog.ts)', () => {
  it('has a meaning and an action for every code an operation can answer, and for no other code', () => {
    const declared = [...new Set(OPERATIONS.flatMap((o) => errorsOf(o).map((e) => e.code)))].sort();
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(declared);
    for (const [code, d] of Object.entries(ERROR_CATALOG)) { expect(d[0].length, code).toBeGreaterThan(15); expect(d[1].length, code).toBeGreaterThan(8); }
  });
  it('covers the mandate reasons, the scopes and the order states exactly', () => {
    expect(Object.keys(MANDATE_DENY_DOCS)).toEqual([...MANDATE_DENY_REASONS]);
    expect(Object.keys(SCOPE_DOCS)).toEqual([...SCOPES]);
    expect(Object.keys(ORDER_STATE_DOCS)).toEqual([...ORDER_STATES]);
  });
  it('is in the OpenAPI document with the statuses of the contract', () => {
    const cat = (buildOpenApi() as any)['x-spw-error-catalog']; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cat.mandate_required).toEqual({ statuses: [403, 409], meaning: ERROR_CATALOG.mandate_required![0], action: ERROR_CATALOG.mandate_required![1] });
    expect(Object.keys(cat)).toHaveLength(Object.keys(ERROR_CATALOG).length);
  });
});

describe('OpenAPI document: what a coding assistant reads', () => {
  const doc = buildOpenApi() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  it('every operation has a summary, a description, an example answer, three code samples, and an example for each required parameter and for its body', () => {
    let n = 0;
    for (const item of Object.values(doc.paths) as any[]) for (const op of Object.values(item) as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      n += 1;
      expect(op.summary.length, op.operationId).toBeGreaterThan(5);
      expect((op.description ?? '').length, `${op.operationId}: description`).toBeGreaterThan(40);
      expect(op.responses['200'].content['application/json'].example, op.operationId).toBeDefined();
      expect(op['x-codeSamples'].map((s: { label: string }) => s.label)).toEqual(['curl', 'TypeScript', 'Python']);
      for (const p of op.parameters) if (p.required && p.in !== 'header') expect(p.example, `${op.operationId}: ${p.name}`).toBeDefined();
      if (op.requestBody) expect(op.requestBody.content['application/json'].example, op.operationId).toBeDefined();
      expect(typeof op['x-spw-example-recorded']).toBe('boolean');
    }
    expect(n).toBe(OPERATIONS.length);
  });
  it('every tag is described, and the document points to the reference', () => {
    for (const t of doc.tags) expect(t.description.length, t.name).toBeGreaterThan(10);
    expect(doc.externalDocs.url).toBe(DOCS_PATH);
  });
  it('every field of a request body is described', () => {
    for (const o of referenceModel().ops) for (const [name, p] of Object.entries((o.body?.properties ?? {}) as Record<string, { description?: string }>)) expect(p.description, `${o.id}.${name}`).toBeTruthy();
  });
});

describe('the facts the guide quotes are the constants of the code', () => {
  const num = (file: string, re: RegExp): number => { const m = re.exec(src(file)); if (!m) throw new Error(`${file}: ${re} not found`); return Number(m[1]!.replace(/_/g, '')); };
  it('limits, windows and retention', () => {
    expect(FACTS.authFailuresPerMin).toBe(num('services/api/src/trading-api/principal.ts', /AUTH_FAILURES_PER_MIN = (\d+)/));
    expect(FACTS.timestampToleranceSec).toBe(num('services/api/src/trading-api/idempotency.ts', /TIMESTAMP_TOLERANCE_SEC = (\d+)/));
    expect(FACTS.webhookMax).toBe(num('services/api/src/trading-api/webhooks.ts', /MAX_WEBHOOKS = (\d+)/));
    expect(FACTS.webhookBackoffSec.map((s) => s * 1000)).toEqual(/WEBHOOK_BACKOFF_MS = \[([^\]]+)\]/.exec(src('services/api/src/trading-api/webhooks.ts'))![1]!.split(',').map((x) => Number(x.trim().replace(/_/g, ''))));
    expect(FACTS.webhookMaxAttempts).toBe(FACTS.webhookBackoffSec.length + 1);
    expect(FACTS.webhookToleranceSec).toBe(num('packages/trading-sdk/src/webhooks.ts', /WEBHOOK_TOLERANCE_SECONDS = (\d+)/));
    expect(FACTS.idempotencyRetentionHours * 3_600_000).toBe(num('services/api/src/trading-api/principal.ts', /delete from api_idempotency where created_at < \$\{new Date\(now - ([\d_]+)\)\}/));
    expect(FACTS.usageRetentionDays).toBe(num('services/api/src/trading-api/principal.ts', /SPW_API_USAGE_RETENTION_DAYS \?\? (\d+)/));
    expect(FACTS.streamTicketTtlSec * 1000).toBe(num('services/api/src/quotes/engine.ts', /ticketTtlMs: ([\d_]+)/));
    expect(FACTS.streamMaxConnKey).toBe(num('services/api/src/quotes/engine.ts', /'SPW_STREAM_MAX_CONN_KEY', (\d+)/));
    expect(FACTS.streamMaxSubs).toBe(num('services/api/src/quotes/engine.ts', /'SPW_STREAM_MAX_SUBS', (\d+)/));
    expect(FACTS.ownerRatePerMin).toBe(num('services/api/src/server.ts', /register\(rateLimit, \{ max: (\d+)/));
  });
  it('the worked webhook example is what the server signs, and what the server\'s own check accepts', () => {
    const w = WEBHOOK_EXAMPLE;
    expect(w.signature).toBe(webhookSignature(w.secret, w.timestamp, w.body));
    expect(verifyWebhook(w.secret, String(w.timestamp), w.signature, w.body, w.timestamp * 1000)).toBe(true);
    expect(verifyWebhook(w.secret, String(w.timestamp), w.signature, `${w.body} `, w.timestamp * 1000)).toBe(false);
    expect(html).toContain(w.signature);
  });
});

describe('the rendered reference (reference.ts)', () => {
  it('every operation of the contract appears in the page with its method, its path, a request example in three languages, an answer and its errors', () => {
    const blocks = html.split('<details class="op" ').slice(1);
    expect(blocks).toHaveLength(OPERATIONS.length);
    for (const op of OPERATIONS) {
      const b = blocks.find((x) => x.startsWith(`id="op-${op.id}"`));
      expect(b, op.id).toBeDefined();
      const block = b!.split('<details class="op" ')[0]!, ex = EXAMPLES[op.id]!;
      expect(block).toContain(`<span class="m ${op.method}">${op.method}</span>`);
      expect(block).toContain(`${op.method} ${TRADING_PREFIX}${op.path.replace(/:([A-Za-z]+)/g, '{$1}')}`);
      for (const label of ['curl', 'TypeScript', 'Python']) expect(block, `${op.id}: ${label}`).toContain(`data-tab="${label}"`);
      expect(block).toContain(exampleUrl(op, ex).replace(/&/g, '&amp;'));
      expect(block).toContain('Example response · 200');
      expect(block, `${op.id}: the answer`).toContain(highlightJson(JSON.stringify(ex.response, null, 2)));
      for (const e of errorsOf(op)) expect(block, `${op.id}: ${e.code}`).toContain(`href="#err-${e.code}"`);
      expect(html).toContain(`href="#op-${op.id}"`);   // the navigation
    }
  });
  it('every link inside the page lands on something: operations, sections, errors, objects', () => {
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));
    const targets = [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!))];
    expect(targets.length).toBeGreaterThan(200);
    for (const t of targets) expect(ids.has(t), `#${t}`).toBe(true);
    for (const g of GUIDE) expect(ids.has(g.id)).toBe(true);
    for (const code of Object.keys(ERROR_CATALOG)) expect(ids.has(`err-${code}`), code).toBe(true);
  });
  it('is self-contained and obeys the server\'s Content-Security-Policy: one same-origin script file, nothing inline that executes, nothing from another origin', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual([`<script src="${DOCS_PATH}.js" defer>`]);
    expect(html).not.toMatch(/<script\b[^>]*>[^<]/);                                   // no inline script body
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);                               // no inline event handler
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<(link|img|iframe|object|embed|video|audio|source|form)\b/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);                        // every src and href is this origin or a fragment
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).not.toMatch(/@import|url\(/);                                          // no font, no image, no stylesheet fetched
    expect(REFERENCE_JS).not.toMatch(/\beval\(|new Function|import\(|fetch\(|XMLHttpRequest|https?:\/\//);
  });
  it('is a phone page first: viewport, light theme by default, one column under 980 px', () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(html).toContain('<html lang="en" data-theme="light" class="no-js">');
    expect(html).toContain('@media (max-width:980px)');
  });
  it('carries the getting started in English and in French, and every concept section', () => {
    for (const g of GUIDE) expect(html).toContain(`<section class="card g" id="${g.id}">`);
    expect(GUIDE.map((g) => g.id)).toEqual(expect.arrayContaining(['getting-started', 'demarrage-rapide', 'authentication', 'paper-live', 'mandates', 'refusals', 'idempotency', 'pagination', 'rate-limits', 'webhooks', 'stream', 'formats', 'instruments']));
    expect(html).toContain('Réglages → Développeur / API → Clés → Nouvelle clé');
    expect(html).toContain('SPW_TRADING_API_EXECUTION');
  });
  it('docs/TRADING-API-REFERENCE.md is exactly what the code generates (run: npx tsx scripts/gen-openapi.mts), and names every operation', () => {
    expect(readFileSync(`${REPO_ROOT}/docs/TRADING-API-REFERENCE.md`, 'utf8')).toBe(md);
    expect(referenceMarkdown()).toBe(md);   // deterministic
    expect(referenceHtml()).toBe(html);
    for (const op of OPERATIONS) { expect(md).toContain(`<a id="op-${op.id}"></a>`); expect(md).toContain(`#### ${op.method} \`${TRADING_PREFIX}${op.path.replace(/:([A-Za-z]+)/g, '{$1}')}\``); }
    for (const code of Object.keys(ERROR_CATALOG)) expect(md).toContain(`<a id="err-${code}"></a>\`${code}\``);
  });
});

describe('Markdown → HTML, the subset the guide writes', () => {
  it('escapes what it is given, and renders code, emphasis, links, lists, tables, notes and tabbed code', () => {
    expect(mdToHtml('a <b> & `x<y` **bold** *it* [t](#z) [`c`](/p)')).toBe('<p>a &lt;b&gt; &amp; <code>x&lt;y</code> <strong>bold</strong> <em>it</em> <a href="#z">t</a> <a href="/p"><code>c</code></a></p>');
    expect(mdToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(mdToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(mdToHtml('| A | B |\n|---|---|\n| `a \\| b` | c |')).toBe('<div class="tw"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><code>a | b</code></td><td>c</td></tr></tbody></table></div>');
    expect(mdToHtml('> **Note.** text')).toBe('<aside class="note"><strong>Note.</strong> text</aside>');
    expect(mdToHtml('### Title `x`', 'p-')).toBe('<h3 id="p-title-x">Title <code>x</code></h3>');
    const tabs = mdToHtml('```bash\ncurl <x>\n```\n\n```ts\nconst a = 1;\n```\n\n```json\n{"a":1}\n```');
    expect(tabs.match(/class="tab"/g)).toHaveLength(2);                        // curl + TypeScript are one group; the JSON block stands alone
    expect(tabs).toContain('curl &lt;x&gt;');
    expect(tabs).toContain('<span class="k">&quot;a&quot;</span>:<span class="n">1</span>');
  });
  it('describes a schema in a line', () => {
    expect(typeOf({ type: 'string' })).toBe('string');
    expect(typeOf({ enum: ['paper', 'live'] })).toBe('"paper" | "live"');
    expect(typeOf({ type: 'array', items: { $ref: '#/components/schemas/Order' } })).toBe('array of Order');
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(typeOf({ type: 'integer', minimum: 1, maximum: 500 })).toBe('integer 1…500');
  });
});
