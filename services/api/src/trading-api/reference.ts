/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/reference.ts
 * Module           : trading-api
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

// The human-readable reference of the SP Trading API, rendered from the same sources as the contract:
//
//   buildOpenApi()   (openapi.ts ← spec.ts)   operations, parameters, schemas, error codes, examples, code samples
//   GUIDE            (guide.ts)               getting started (EN + FR) and the concepts, as Markdown
//   ERROR_CATALOG    (error-catalog.ts)       what each code means and what to do
//
//   referenceMarkdown()   docs/TRADING-API-REFERENCE.md (committed; a test compares) and GET /api/v1/trading/docs.md
//   referenceHtml()       GET /api/v1/trading/docs — one self-contained page: no CDN, no external font, script or image
//   REFERENCE_JS          GET /api/v1/trading/docs.js — search, copy, tabs, theme. A separate same-origin file because the
//                         server's Content-Security-Policy is `script-src 'self'`: an inline script would not run. The page
//                         is complete without it (everything is in the HTML; the script only adds comfort).
//
// Pure and deterministic: the same code always gives the same bytes.
import { ERROR_CATALOG, MANDATE_DENY_DOCS } from './error-catalog.ts';
import { DOCS_PATH, GUIDE } from './guide.ts';
import { buildOpenApi } from './openapi.ts';
import { API_VERSION, TRADING_PREFIX } from './spec.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document

// ------------------------------------------------------------------------------------------------------------------ model
export interface RefOp {
  id: string; method: string; path: string; tag: string; summary: string; description: string; scope: string; mandate: boolean; idempotent: boolean; open: boolean;
  params: Json[]; body: Json | null; bodyExample: unknown; response: Json | null; responseExample: unknown; recorded: boolean; note: string;
  samples: { lang: string; label: string; source: string }[]; errors: { status: number; code: string }[];
}
export function referenceModel(): { doc: Json; ops: RefOp[]; tags: { name: string; description: string; ops: RefOp[] }[] } {
  const doc = buildOpenApi() as Json, ops: RefOp[] = [];
  for (const [path, item] of Object.entries(doc.paths as Record<string, Json>)) for (const [method, op] of Object.entries(item as Record<string, Json>)) {
    const ok = op.responses?.['200']?.content?.['application/json'], rb = op.requestBody?.content?.['application/json'];
    ops.push({ id: op.operationId, method: method.toUpperCase(), path, tag: op.tags[0], summary: op.summary, description: op.description ?? '', scope: op['x-spw-scope'], mandate: op['x-spw-requires-mandate'] === true,
      idempotent: op['x-spw-idempotent'] === true, open: op['x-spw-errors-open'] === true, params: op.parameters ?? [], body: rb?.schema ?? null, bodyExample: rb?.example, response: ok?.schema ?? null, responseExample: ok?.example,
      recorded: op['x-spw-example-recorded'] === true, note: op['x-spw-example-note'] ?? '', samples: op['x-codeSamples'] ?? [], errors: op['x-spw-errors'] ?? [] });
  }
  const tags = (doc.tags as { name: string; description: string }[]).map((t) => ({ ...t, ops: ops.filter((o) => o.tag === t.name) })).filter((t) => t.ops.length);
  return { doc, ops, tags };
}

// ------------------------------------------------------------------------------------------------------------------ JSON Schema → words
const refName = (s: Json): string | null => (typeof s.$ref === 'string' ? s.$ref.split('/').pop()! : null);
/** one line for a schema: `string`, `integer 1…500`, `"paper" | "live"`, `array of Order`, `string | null` */
export function typeOf(s: Json | undefined | boolean): string {
  if (s === undefined || s === true) return 'any';
  if (s === false) return 'never';
  const r = refName(s);
  if (r) return r;
  if (Array.isArray(s.enum)) return s.enum.map((x: unknown) => JSON.stringify(x)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.anyOf)) return [...new Set((s.anyOf as Json[]).map((x) => typeOf(x)))].join(' | ');
  if (Array.isArray(s.prefixItems)) return `[${(s.prefixItems as Json[]).map((x) => typeOf(x)).join(', ')}]`;
  let t = Array.isArray(s.type) ? s.type.join(' | ') : String(s.type ?? 'any');
  if (t === 'array') return `array of ${typeOf(s.items)}`;
  if (t === 'object' && !s.properties && s.additionalProperties && typeof s.additionalProperties === 'object') return `map of ${typeOf(s.additionalProperties)}`;
  const lo = s.minimum ?? s.exclusiveMinimum, hi = s.maximum ?? s.exclusiveMaximum;
  if (lo !== undefined || hi !== undefined) t += ` ${lo ?? ''}…${hi ?? ''}`;
  return t;
}
/** the constraints a caller must respect, in words */
export function constraintsOf(s: Json): string {
  const out: string[] = [];
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
  if (s.minLength !== undefined || s.maxLength !== undefined) out.push(s.minLength === s.maxLength ? `${s.minLength} characters` : `${s.minLength ?? 0}–${s.maxLength ?? '∞'} characters`);
  if (s.minItems !== undefined || s.maxItems !== undefined) out.push(`${s.minItems ?? 0}–${s.maxItems ?? '∞'} items`);
  if (typeof s.format === 'string') out.push(s.format === 'uuid' ? 'a UUID' : s.format === 'date-time' ? 'ISO 8601 date-time' : `format ${s.format}`);
  else if (typeof s.pattern === 'string') out.push(`pattern ${s.pattern}`);
  return out.join(' · ');
}
export interface FieldRow { name: string; type: string; required: boolean; description: string; constraints: string }
const objectIn = (s: Json): Json | null => {
  if (refName(s)) return null;
  if (s.type === 'object' && s.properties) return s;
  if (s.type === 'array' && s.items && typeof s.items === 'object') return objectIn(s.items);
  if (Array.isArray(s.anyOf)) { const objs = (s.anyOf as Json[]).map(objectIn).filter(Boolean) as Json[]; return objs.length === 1 ? objs[0]! : null; }
  return null;
};
/** the fields of an object schema, nested ones dotted (`order.id`, `fills[].price`), to `depth` levels */
export function fieldRows(s: Json, depth = 2, prefix = ''): FieldRow[] {
  const out: FieldRow[] = [], required = new Set<string>((s.required as string[] | undefined) ?? []);
  for (const [k, p] of Object.entries((s.properties ?? {}) as Record<string, Json>)) {
    const isArr = p.type === 'array' || (Array.isArray(p.anyOf) && (p.anyOf as Json[]).some((x) => x.type === 'array'));
    const name = `${prefix}${k}`;
    out.push({ name, type: typeOf(p), required: required.has(k), description: String(p.description ?? ''), constraints: constraintsOf(p) });
    const inner = objectIn(p);
    if (inner && depth > 1) out.push(...fieldRows(inner, depth - 1, `${name}${isArr ? '[]' : ''}.`));
  }
  return out;
}
/** an answer that is one of several shapes (POST /commands): each variant with its own fields */
const variantsOf = (s: Json): Json[] | null => (Array.isArray(s.anyOf) && (s.anyOf as Json[]).filter((x) => x.type === 'object').length > 1 ? (s.anyOf as Json[]) : null);

// ------------------------------------------------------------------------------------------------------------------ Markdown
const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fence = (lang: string, src: string): string => `\`\`\`${lang}\n${src}\n\`\`\``;
const jsonText = (v: unknown): string => JSON.stringify(v, null, 2);
const LANG: Record<string, string> = { Shell: 'bash', TypeScript: 'ts', Python: 'python' };
const fieldsMd = (rows: FieldRow[]): string[] => ['| Field | Type | Required | Description |', '|---|---|---|---|',
  ...rows.map((r) => `| \`${r.name}\` | \`${mdCell(r.type)}\` | ${r.required ? 'yes' : '—'} | ${mdCell([r.description, r.constraints].filter(Boolean).join(' — '))} |`)];
const byStatus = (errors: { status: number; code: string }[]): [number, string[]][] => { const m = new Map<number, string[]>(); for (const e of errors) m.set(e.status, [...(m.get(e.status) ?? []), e.code]); return [...m]; };
const allCodes = (ops: RefOp[]): Map<string, Set<number>> => { const m = new Map<string, Set<number>>(); for (const o of ops) for (const e of o.errors) m.set(e.code, (m.get(e.code) ?? new Set()).add(e.status)); return new Map([...m].sort(([a], [b]) => (a < b ? -1 : 1))); };

export function referenceMarkdown(): string {
  const { ops, tags, doc } = referenceModel(), L: string[] = [];
  L.push('# SP Trading API — reference', '', '> Generated by `npx tsx scripts/gen-openapi.mts` from `services/api/src/trading-api/` (`spec.ts`, `examples.ts`, `guide.ts`, `error-catalog.ts`). Do not edit by hand:',
    '> a test compares this file with what the code generates. The same content is served by the wallet at', `> \`GET ${DOCS_PATH}\` (HTML) and \`GET ${DOCS_PATH}.md\` (this Markdown).`, '',
    `Version ${API_VERSION} · ${ops.length} operations · OpenAPI 3.1: [\`docs/openapi/trading-v1.json\`](openapi/trading-v1.json), served at \`GET ${TRADING_PREFIX}/openapi.json\`.`, '', '## Contents', '');
  for (const g of GUIDE) L.push(`- [${g.title}](#${g.id})`);
  L.push('- [Operations](#operations)');
  for (const t of tags) L.push(`  - [${t.name}](#tag-${t.name.toLowerCase()}) — ${t.ops.map((o) => `[\`${o.id}\`](#op-${o.id})`).join(', ')}`);
  L.push('- [Objects](#objects)', '- [Error catalogue](#error-catalogue)', '');
  for (const g of GUIDE) L.push(`<a id="${g.id}"></a>`, '', `## ${g.title}`, '', g.md, '');

  L.push('<a id="operations"></a>', '', '## Operations', '', '| Method | Path | Operation | Permission | Idempotency-Key |', '|---|---|---|---|---|');
  for (const o of ops) L.push(`| ${o.method} | \`${o.path}\` | [\`${o.id}\`](#op-${o.id}) — ${mdCell(o.summary)} | ${o.scope === 'any valid key' ? 'any valid key' : `\`${o.scope}\``}${o.mandate ? ' + mandate' : ''} | ${o.idempotent ? 'required' : '—'} |`);
  L.push('');
  for (const t of tags) {
    L.push(`<a id="tag-${t.name.toLowerCase()}"></a>`, '', `### ${t.name}`, '', t.description, '');
    for (const o of t.ops) {
      L.push(`<a id="op-${o.id}"></a>`, '', `#### ${o.method} \`${o.path}\``, '', `**${o.summary}.** Operation id \`${o.id}\`.`, '');
      L.push(`- **Permission:** ${o.scope === 'any valid key' ? 'any valid key' : `\`${o.scope}\``}${o.mandate ? ' — and a trading mandate bound to the key (403 `mandate_required` otherwise)' : ''}`,
        `- **Idempotency-Key:** ${o.idempotent ? 'required (8–100 characters). The same key with the same request returns the first answer; nothing runs twice' : 'not used'}`,
        `- **Side effects:** ${o.method === 'GET' ? 'none (a read)' : o.id === 'previewOrder' ? 'none: creates, signs and sends nothing' : 'yes — see the description'}`, '');
      if (o.description) L.push(o.description, '');
      const ps = o.params.filter((p) => p.in !== 'header');
      if (ps.length) { L.push('**Parameters**', '', '| Name | In | Type | Required | Description |', '|---|---|---|---|---|');
        for (const p of ps) L.push(`| \`${p.name}\` | ${p.in} | \`${mdCell(typeOf(p.schema))}\` | ${p.required ? 'yes' : '—'} | ${mdCell([p.description ?? '', constraintsOf(p.schema)].filter(Boolean).join(' — '))} |`);
        L.push(''); }
      if (o.body) { const rows = fieldRows(o.body, 2); if (rows.length) L.push('**Request body** (JSON; unknown fields are refused)', '', ...fieldsMd(rows), ''); }
      L.push('**Example request**', '');
      for (const s of o.samples) L.push(fence(LANG[s.lang] ?? 'text', s.source), '');
      L.push(`**Example response** — 200${o.recorded ? ', recorded from a real server' : ', written from the schema (not recorded)'}${o.note ? `. ${o.note}` : ''}`, '', fence('json', jsonText(o.responseExample)), '');
      if (o.response) {
        const vs = variantsOf(o.response);
        if (vs) { L.push('**Response** — one of:', ''); vs.forEach((v, i) => L.push(`${i + 1}. ${v.description ?? 'variant'}`, '', ...fieldsMd(fieldRows(v, 1)), '')); }
        else { const rows = fieldRows(o.response, 2); if (rows.length) L.push('<details><summary><b>Response fields</b></summary>', '', ...fieldsMd(rows), '', '</details>', ''); }
      }
      L.push(`**Errors**${o.open ? ' (open: the executing venue engine can add a code of its own rules)' : ''}`, '', '| Status | Codes |', '|---|---|');
      for (const [status, codes] of byStatus(o.errors)) L.push(`| ${status} | ${codes.map((c) => `[\`${c}\`](#err-${c})`).join(', ')} |`);
      L.push('');
    }
  }
  L.push('<a id="objects"></a>', '', '## Objects', '', 'Shapes the answers share (`#/components/schemas/<name>` in the OpenAPI document).', '');
  for (const [name, s] of Object.entries(doc.components.schemas as Record<string, Json>)) L.push(`<a id="schema-${name}"></a>`, '', `### ${name}`, '', s.description ? `${s.description}` : '', '', ...fieldsMd(fieldRows(s, 2)), '');
  L.push('<a id="error-catalogue"></a>', '', '## Error catalogue', '', `Every code an operation of this API can answer (${allCodes(ops).size}), with what it means and what to do. The \`message\` of a real answer carries the figures of the case.`, '',
    '| Code | Status | Meaning | What to do |', '|---|---|---|---|');
  for (const [c, st] of allCodes(ops)) { const d = ERROR_CATALOG[c] ?? ['', '']; L.push(`| <a id="err-${c}"></a>\`${c}\` | ${[...st].sort().join(', ')} | ${mdCell(d[0])} | ${mdCell(d[1])} |`); }
  L.push('');
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ------------------------------------------------------------------------------------------------------------------ Markdown → HTML (the subset guide.ts writes)
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s: string): string => s.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9àâçéèêëîïôûùüÿœ]+/g, '-').replace(/^-|-$/g, '');
/** inline Markdown: `code`, **bold**, *emphasis*, [text](url) — code spans are left alone */
export function inline(s: string): string {
  return s.split(/(`[^`]*`)/).map((part) => {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }).join('');
}
/** `[`code`](url)` is split by the code-span pass: handle links whose text is a code span first */
const inl = (s: string): string => {
  const held: string[] = [];
  const t = s.replace(/\[(`[^`]+`)\]\(([^)\s]+)\)/g, (_m, c: string, u: string) => { held.push(`<a href="${esc(u)}"><code>${esc(c.slice(1, -1))}</code></a>`); return `\u0000${held.length - 1}\u0000`; });
  return inline(t).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]!);
};
const TAB_LANGS = new Set(['bash', 'ts', 'python']);
const LANG_LABEL: Record<string, string> = { bash: 'curl', ts: 'TypeScript', python: 'Python', json: 'JSON', http: 'HTTP', text: '' };
/** JSON with classed spans (keys, strings, numbers, literals): colour is CSS, there is no script behind it */
export function highlightJson(src: string): string {
  return esc(src).replace(/(&quot;(?:[^&\\]|\\.|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
    (m, str?: string, colon?: string, lit?: string, num?: string) => (str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`) : lit ? `<span class="l">${lit}</span>` : num ? `<span class="n">${num}</span>` : m));
}
const highlight = (lang: string, src: string): string => (lang === 'json' ? highlightJson(src)
  : esc(src).split('\n').map((l) => (/^\s*(#|\/\/)/.test(l) ? `<span class="c">${l}</span>` : l.replace(/(\s)(#|\/\/) (.*)$/, '$1<span class="c">$2 $3</span>'))).join('\n'));
export const codeBlock = (lang: string, src: string, label = ''): string =>
  `<div class="code" data-lang="${esc(lang)}">${label || LANG_LABEL[lang] ? `<div class="code-h"><span>${esc(label || LANG_LABEL[lang] || lang)}</span></div>` : ''}<pre tabindex="0"><code>${highlight(lang, src)}</code></pre></div>`;
const tabGroup = (blocks: { lang: string; src: string; title: string }[]): string => `<div class="tabs">${blocks.map((b) =>
  `<section class="tab" data-tab="${esc(b.title || LANG_LABEL[b.lang] || b.lang)}">${codeBlock(b.lang, b.src, b.title || LANG_LABEL[b.lang] || b.lang)}</section>`).join('')}</div>`;

export function mdToHtml(md: string, idPrefix = ''): string {
  const lines = md.split('\n'), out: string[] = [];
  let i = 0;
  const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i += 1; continue; }
    if (line.startsWith('```')) {
      const blocks: { lang: string; src: string; title: string }[] = [];
      // consecutive fenced blocks (blank lines between) in curl / TypeScript / Python become one tabbed group
      for (;;) {
        const info = lines[i]!.slice(3).trim(), lang = info.split(/\s+/)[0] ?? '', title = /title="([^"]*)"/.exec(info)?.[1] ?? '', buf: string[] = [];
        i += 1;
        while (i < lines.length && !lines[i]!.startsWith('```')) { buf.push(lines[i]!); i += 1; }
        i += 1;
        blocks.push({ lang, src: buf.join('\n'), title });
        let k = i;
        while (k < lines.length && lines[k]!.trim() === '') k += 1;
        if (k < lines.length && lines[k]!.startsWith('```') && TAB_LANGS.has(lang) && TAB_LANGS.has(lines[k]!.slice(3).trim().split(/\s+/)[0] ?? '')) { i = k; continue; }
        break;
      }
      out.push(blocks.length > 1 ? tabGroup(blocks) : codeBlock(blocks[0]!.lang, blocks[0]!.src, blocks[0]!.title));
      continue;
    }
    const h = /^(#{3,5}) (.*)$/.exec(line);
    if (h) { const level = h[1]!.length; out.push(`<h${level} id="${esc(`${idPrefix}${slug(h[2]!)}`)}">${inl(h[2]!)}</h${level}>`); i += 1; continue; }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) { rows.push(lines[i]!); i += 1; }
      const head = cells(rows[0]!), body = rows.slice(2).map(cells), bare = head.every((c) => c === '');
      out.push(`<div class="tw"><table${head.length >= 4 ? ' class="wide"' : ''}>${bare ? '' : `<thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join('')}</tr></thead>`}<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) { buf.push(lines[i]!.replace(/^> ?/, '')); i += 1; }
      out.push(`<aside class="note">${inl(buf.join(' '))}</aside>`);
      continue;
    }
    const li = /^(- |\d+\. )/.exec(line);
    if (li) {
      const ordered = /^\d/.test(line), items: string[] = [];
      while (i < lines.length && (ordered ? /^\d+\. /.test(lines[i]!) : lines[i]!.startsWith('- '))) { items.push(lines[i]!.replace(/^(- |\d+\. )/, '')); i += 1; }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inl(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(```|\||> |#{3,5} |- |\d+\. )/.test(lines[i]!)) { buf.push(lines[i]!); i += 1; }
    out.push(`<p>${inl(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------------------------------ HTML
const CSS = `
:root{--bg:#f3f4f7;--surface:#fff;--elev:#eceef3;--line:rgba(13,18,32,.1);--ink:#0a0d14;--mute:#596273;--emerald:#087a55;--blue:#2257e0;--warn:#9a5b06;--danger:#c22a40;
--code:#f6f7fa;--e1:0 1px 1px rgba(13,18,32,.03),0 6px 20px -10px rgba(13,18,32,.12);--e2:0 2px 4px rgba(13,18,32,.06),0 12px 28px -10px rgba(13,18,32,.28);
--sans:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',system-ui,sans-serif;--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;--side:292px;--top:56px;color-scheme:light}
[data-theme=dark]{--bg:#06080c;--surface:#0f131b;--elev:#1a202c;--line:rgba(240,244,255,.11);--ink:#f4f6fa;--mute:#98a2b6;--emerald:#35e7ac;--blue:#7ea6ff;--warn:#f4b65b;--danger:#ff7d88;
--code:#0b0e14;--e1:0 1px 0 rgba(255,255,255,.035) inset,0 8px 24px -14px rgba(0,0,0,.8);--e2:0 1px 0 rgba(255,255,255,.06) inset,0 12px 28px -10px rgba(0,0,0,.85);color-scheme:dark}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--top) + 14px);scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.55 var(--sans);overflow-wrap:break-word}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:6px}
code{font:.88em var(--mono);background:var(--elev);padding:.1em .36em;border-radius:6px;overflow-wrap:break-word}
a code{color:inherit}
h1,h2,h3,h4,h5{font-family:var(--sans);letter-spacing:-.02em;line-height:1.2;text-wrap:balance;margin:0}
.top{position:sticky;top:0;z-index:30;height:var(--top);display:flex;align-items:center;gap:10px;padding:0 14px;background:color-mix(in srgb,var(--surface) 86%,transparent);backdrop-filter:saturate(1.6) blur(14px);-webkit-backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid var(--line)}
.brand{font-weight:650;font-size:16px;color:var(--ink);white-space:nowrap}.brand small{font-weight:500;color:var(--mute);margin-left:6px;font-size:12.5px}
.search{flex:1;min-width:0;max-width:440px;margin-left:auto}
.search input{width:100%;height:38px;border:1px solid var(--line);border-radius:12px;background:var(--elev);color:var(--ink);font:16px var(--sans);padding:0 12px}
.btn{height:38px;min-width:38px;padding:0 11px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font:600 13.5px var(--sans);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.btn:hover{background:var(--elev)}
.menu{display:none}
.shell{display:grid;grid-template-columns:var(--side) minmax(0,1fr);max-width:1320px;margin:0 auto}
nav.side{position:sticky;top:var(--top);align-self:start;height:calc(100vh - var(--top));overflow-y:auto;padding:18px 10px 40px 16px;font-size:14px}
nav.side h2{font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:18px 8px 6px}
nav.side h2:first-child{margin-top:0}
nav.side a{display:flex;align-items:baseline;gap:7px;padding:5px 8px;border-radius:9px;color:var(--ink);line-height:1.3}
nav.side a:hover{background:var(--elev);text-decoration:none}
nav.side a.on{background:var(--elev);font-weight:600}
nav.side a .p{font:12.5px var(--mono);overflow-wrap:anywhere;min-width:0}
main{min-width:0;padding:22px 22px 80px}
.hero{padding:6px 2px 4px}.hero h1{font-size:32px;font-weight:680;letter-spacing:-.03em}.hero p{color:var(--mute);margin:8px 0 0;max-width:68ch}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:var(--e1);padding:22px;margin-top:18px}
section.g>h2{font-size:23px;font-weight:660;margin-bottom:12px}
section.g h3{font-size:17.5px;font-weight:640;margin:26px 0 8px}section.g h4{font-size:15.5px;font-weight:640;margin:20px 0 6px}
p{margin:10px 0}ul,ol{margin:10px 0;padding-left:22px}li{margin:5px 0}
.g p,.g li{max-width:78ch}
aside.note{margin:14px 0;padding:12px 14px;border-radius:16px;background:color-mix(in srgb,var(--warn) 9%,var(--surface));border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);font-size:14.5px}
.tw{overflow-x:auto;margin:12px 0;border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line)}
th{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);background:var(--elev);white-space:nowrap}tr:last-child td{border-bottom:0}
td:first-child{white-space:nowrap}td:first-child code{white-space:nowrap}
.code{margin:12px 0;border:1px solid var(--line);border-radius:14px;background:var(--code);overflow:hidden;position:relative}
.code-h{display:flex;align-items:center;justify-content:space-between;min-height:34px;padding:0 6px 0 12px;font:600 12px var(--sans);color:var(--mute);border-bottom:1px solid var(--line);letter-spacing:.03em}
pre{margin:0;padding:12px 14px;overflow:auto;max-height:520px;font:12.8px/1.6 var(--mono);tab-size:2;-webkit-overflow-scrolling:touch}
pre code{background:none;padding:0;font:inherit;border-radius:0;overflow-wrap:normal;white-space:pre}
.k{color:var(--blue)}.s{color:var(--emerald)}.n{color:var(--warn)}.l{color:var(--danger)}.c{color:var(--mute);font-style:italic}
.copy{height:26px;padding:0 9px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--mute);font:600 11.5px var(--sans);cursor:pointer}
.copy:hover{color:var(--ink)}.code>.copy{position:absolute;top:6px;right:6px}
.tabs{margin:12px 0}.tabs .code{margin:0}.tabbar{display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap}
.tabbar button{height:32px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--mute);font:600 13px var(--sans);cursor:pointer}
.tabbar button[aria-selected=true]{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.js .tabs .tab[hidden]{display:none}.tabs .tab+.tab{margin-top:8px}.js .tabs .tab+.tab{margin-top:0}
.tag{margin-top:34px}.tag>h2{font-size:23px;font-weight:660}.tag>p{color:var(--mute);margin:6px 0 0;max-width:78ch}
.op{background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:var(--e1);margin-top:14px;overflow:hidden}
.op>summary{list-style:none;cursor:pointer;padding:15px 18px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 10px;align-items:center}
.op>summary::-webkit-details-marker{display:none}
.op>summary:hover{background:color-mix(in srgb,var(--elev) 45%,var(--surface))}
.op>summary .path{font:600 14px var(--mono);overflow-wrap:anywhere;min-width:0}
.op>summary .sum{grid-column:1/-1;color:var(--mute);font-size:14.5px}
.op>summary .chev{width:9px;height:9px;border-right:2px solid var(--mute);border-bottom:2px solid var(--mute);transform:rotate(45deg);transition:transform .15s;margin:0 4px 4px}
.op[open]>summary .chev{transform:rotate(225deg);margin:4px 4px 0}
.op[open]>summary{border-bottom:1px solid var(--line)}
.ob{padding:6px 18px 20px}
.ob h5{font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:22px 0 8px}
.m{display:inline-block;min-width:52px;text-align:center;padding:3px 7px;border-radius:8px;font:700 11.5px var(--mono);letter-spacing:.03em;color:#fff}
.m.GET{background:var(--blue)}.m.POST{background:var(--emerald)}.m.DELETE{background:var(--danger)}[data-theme=dark] .m{color:#06080c}
nav.side .m{min-width:38px;padding:1px 4px;font-size:10px;flex:none}
.pill{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:var(--elev);color:var(--ink);border:1px solid var(--line)}
.pill.scope{color:var(--blue)}.pill.warn{color:var(--warn)}.pill.ok{color:var(--emerald)}.pill.mute{color:var(--mute)}
.facts{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0 4px}
.f{padding:10px 0;border-bottom:1px solid var(--line)}.f:last-child{border-bottom:0}
.fh{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 9px}.fh>code:first-child{font-weight:650;background:none;padding:0;font-size:13.5px}
.ty{font:12.5px var(--mono);color:var(--mute);overflow-wrap:anywhere}.req{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--danger)}.in{font-size:11.5px;color:var(--mute)}
.fd{color:var(--mute);font-size:14px;margin-top:3px;max-width:86ch}.fc{font:12px var(--mono);color:var(--mute);margin-top:3px;overflow-wrap:anywhere}
.f.sub{padding-left:16px}
details.more{margin-top:10px;border:1px solid var(--line);border-radius:14px}details.more>summary{cursor:pointer;padding:10px 14px;font-weight:600;font-size:14px}details.more>div{padding:0 14px 6px;border-top:1px solid var(--line)}
.errs{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 12px;align-items:baseline}
.errs .st{font:700 12.5px var(--mono);color:var(--mute)}.errs .cs{display:flex;flex-wrap:wrap;gap:5px}
.errs a{font:12.5px var(--mono);padding:2px 7px;border-radius:7px;background:var(--elev);color:var(--ink);border:1px solid var(--line)}
.rec{font-size:12.5px;color:var(--mute);margin:6px 0 0}
.cat .f code:first-child{font-size:14px}.cat .st{font:600 12px var(--mono);color:var(--mute)}
.cat .do{font-size:14px;margin-top:3px}.cat .do b{font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--emerald);margin-right:6px}
.empty{display:none;color:var(--mute);padding:26px 4px}.empty.show{display:block}
[data-hide]{display:none!important}
footer{color:var(--mute);font-size:13px;margin-top:40px;padding:0 2px}
.scrim{display:none}
@media (max-width:980px){
.shell{display:block}.menu{display:inline-flex}
.no-js nav.side{position:static;height:auto;max-height:50vh;border-bottom:1px solid var(--line)}
.js nav.side{position:fixed;top:var(--top);left:0;bottom:0;width:min(86vw,330px);height:auto;background:var(--surface);border-right:1px solid var(--line);box-shadow:var(--e2);z-index:25;transform:translateX(-105%);transition:transform .2s;visibility:hidden}
.js.nav-open nav.side{transform:none;visibility:visible}
.js.nav-open .scrim{display:block;position:fixed;inset:var(--top) 0 0 0;background:rgba(10,13,20,.42);z-index:20}
main{padding:14px 12px 70px}.card{padding:16px 14px;border-radius:20px}.op{border-radius:20px}.op>summary{padding:13px 14px}.ob{padding:4px 14px 16px}
.hero h1{font-size:26px}section.g>h2,.tag>h2{font-size:20.5px}
.brand small{display:none}pre{font-size:12.2px;max-height:440px}
td:first-child,td:first-child code{white-space:normal}
.tw table.wide{min-width:680px}
}
@media (max-width:420px){.brand{font-size:15px}.btn.theme span{display:none}}
@media print{.top,nav.side{display:none}.shell{display:block}.op{break-inside:avoid}}
`.trim();

const fieldsHtml = (rows: FieldRow[], where?: (name: string) => string): string => rows.map((r) =>
  `<div class="f${r.name.includes('.') ? ' sub' : ''}"><div class="fh"><code>${esc(r.name)}</code><span class="ty">${esc(r.type)}</span>${where ? `<span class="in">${esc(where(r.name))}</span>` : ''}${r.required ? '<span class="req">required</span>' : ''}</div>${
    r.description ? `<div class="fd">${inl(r.description)}</div>` : ''}${r.constraints ? `<div class="fc">${esc(r.constraints)}</div>` : ''}</div>`).join('');

function opHtml(o: RefOp): string {
  const ps = o.params, search = [o.method, o.path, o.id, o.summary, o.scope, o.tag].join(' ').toLowerCase();
  const paramRows: FieldRow[] = ps.map((p) => ({ name: p.name, type: typeOf(p.schema), required: !!p.required, description: p.description ?? '', constraints: constraintsOf(p.schema) }));
  const inOf = new Map(ps.map((p) => [p.name as string, p.in as string]));
  const H: string[] = [];
  H.push(`<details class="op" id="op-${esc(o.id)}" data-search="${esc(search)}"><summary><span class="m ${o.method}">${o.method}</span><span class="path">${esc(o.path.replace(TRADING_PREFIX, ''))}</span><span class="chev" aria-hidden="true"></span><span class="sum">${esc(o.summary)}</span></summary><div class="ob">`);
  H.push(`<div class="facts"><span class="pill scope">${o.scope === 'any valid key' ? 'any valid key' : esc(o.scope)}</span>${o.mandate ? '<a class="pill warn" href="#mandates">needs a mandate</a>' : ''}${
    o.idempotent ? '<a class="pill" href="#idempotency">Idempotency-Key required</a>' : o.method !== 'GET' ? '<span class="pill mute">no Idempotency-Key</span>' : ''}${
    o.method === 'GET' || o.id === 'previewOrder' ? '<span class="pill ok">no side effect</span>' : ''}<span class="pill mute">${esc(o.id)}</span></div>`);
  H.push(`<p><code>${o.method} ${esc(o.path)}</code></p>`);
  for (const para of o.description.split(/\n\n+/).filter(Boolean)) H.push(`<p>${inl(para)}</p>`);
  if (paramRows.length) H.push(`<h5>Parameters</h5>${fieldsHtml(paramRows, (n) => inOf.get(n) ?? '')}`);
  if (o.body) { const rows = fieldRows(o.body, 2); if (rows.length) H.push(`<h5>Request body</h5>${fieldsHtml(rows)}`); }
  H.push('<h5>Example request</h5>', `<div class="tabs">${o.samples.map((s) => `<section class="tab" data-tab="${esc(s.label)}">${codeBlock(LANG[s.lang] ?? 'text', s.source, s.label)}</section>`).join('')}</div>`);
  H.push(`<h5>Example response · 200</h5>`, codeBlock('json', jsonText(o.responseExample), 'JSON'), `<p class="rec">${o.recorded ? 'Recorded from a real server (the SDK test stack, paper account).' : 'Written from the schema — not recorded.'}${o.note ? ` ${inl(o.note)}` : ''}</p>`);
  if (o.response) {
    const vs = variantsOf(o.response);
    const inner = vs ? vs.map((v, i) => `<h5>Variant ${i + 1}${v.description ? ` — ${esc(v.description)}` : ''}</h5>${fieldsHtml(fieldRows(v, 1))}`).join('') : fieldsHtml(fieldRows(o.response, 2));
    if (inner) H.push(`<details class="more"><summary>Response fields</summary><div>${inner}</div></details>`);
  }
  H.push(`<h5>Errors${o.open ? ' · open list' : ''}</h5><div class="errs">${byStatus(o.errors).map(([st, codes]) => `<span class="st">${st}</span><span class="cs">${codes.map((c) => `<a href="#err-${esc(c)}">${esc(c)}</a>`).join('')}</span>`).join('')}</div>`);
  if (o.open) H.push('<p class="rec">Open list: the venue engine that executes the order can refuse it with a code of its own rules that is not named here. The HTTP status still tells the class, and the order is in <code>data.order</code>.</p>');
  H.push('</div></details>');
  return H.join('');
}

export function referenceHtml(): string {
  const { ops, tags, doc } = referenceModel(), codes = allCodes(ops);
  const nav: string[] = [];
  for (const group of ['Start', 'Concepts'] as const) { nav.push(`<h2>${group === 'Start' ? 'Start here' : group}</h2>`); for (const g of GUIDE.filter((x) => x.group === group)) nav.push(`<a href="#${g.id}">${esc(g.title)}</a>`); }
  for (const t of tags) { nav.push(`<h2>${esc(t.name)}</h2>`); for (const o of t.ops) nav.push(`<a href="#op-${esc(o.id)}" data-op="${esc(o.id)}"><span class="m ${o.method}">${o.method === 'DELETE' ? 'DEL' : o.method}</span><span class="p">${esc(o.path.replace(TRADING_PREFIX, ''))}</span></a>`); }
  nav.push('<h2>Reference</h2><a href="#objects">Objects</a><a href="#error-catalogue">Error catalogue</a>');
  const B: string[] = [];
  B.push(`<div class="hero"><h1>SP Trading API</h1><p>Reference of the machine interface of SP Wallet — ${ops.length} operations under <code>${TRADING_PREFIX}</code>. Generated from the route table the server runs; every answer marked “recorded” came from a real server.</p>`,
    `<div class="pills"><span class="pill">v${esc(API_VERSION)}</span><a class="pill scope" href="${TRADING_PREFIX}/openapi.json">openapi.json</a><a class="pill scope" href="${DOCS_PATH}.md">Markdown</a><a class="pill scope" href="#getting-started">Getting started</a><a class="pill scope" href="#demarrage-rapide">Français</a></div></div>`);
  for (const g of GUIDE) B.push(`<section class="card g" id="${g.id}"><h2>${esc(g.title)}</h2>${mdToHtml(g.md, `${g.id}-`)}</section>`);
  B.push('<div id="operations"></div>');
  for (const t of tags) B.push(`<section class="tag" id="tag-${esc(t.name.toLowerCase())}"><h2>${esc(t.name)}</h2><p>${inl(t.description)}</p>${t.ops.map(opHtml).join('')}</section>`);
  B.push('<p class="empty" id="no-match">No operation matches this search.</p>');
  B.push(`<section class="card g" id="objects"><h2>Objects</h2><p>Shapes the answers share.</p>${Object.entries(doc.components.schemas as Record<string, Json>).map(([name, s]) =>
    `<h3 id="schema-${esc(name)}">${esc(name)}</h3>${s.description ? `<p>${inl(String(s.description))}</p>` : ''}${fieldsHtml(fieldRows(s, 2))}`).join('')}</section>`);
  B.push(`<section class="card g cat" id="error-catalogue"><h2>Error catalogue</h2><p>Every code an operation can answer (${codes.size}), what it means and what to do. The <code>message</code> of a real answer carries the figures of the case.</p>${[...codes].map(([c, st]) => {
    const d = ERROR_CATALOG[c] ?? ['', ''];
    return `<div class="f" id="err-${esc(c)}" data-search="${esc(`${c} ${d[0]}`.toLowerCase())}"><div class="fh"><code>${esc(c)}</code><span class="st">${[...st].sort().join(' · ')}</span></div><div class="fd">${inl(d[0])}</div><div class="do"><b>Do</b>${inl(d[1])}</div></div>`;
  }).join('')}</section>`);
  B.push(`<footer>SP Trading API v${esc(API_VERSION)} · generated from <code>services/api/src/trading-api/spec.ts</code> · the same content as Markdown: <a href="${DOCS_PATH}.md">docs.md</a></footer>`);
  return `<!doctype html>
<html lang="en" data-theme="light" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="theme-color" content="#f3f4f7">
<title>SP Trading API — reference</title>
<style>${CSS}</style>
<script src="${DOCS_PATH}.js" defer></script>
</head>
<body>
<header class="top"><button class="btn menu" id="menu" type="button" aria-label="Contents" aria-controls="side" aria-expanded="false">☰</button><a class="brand" href="#top">SP Trading API<small>v${esc(API_VERSION)}</small></a>
<div class="search"><input id="q" type="search" placeholder="Search" aria-label="Search operations and errors" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
<button class="btn theme" id="theme" type="button" aria-label="Switch theme">◐</button></header>
<div class="scrim" id="scrim"></div>
<div class="shell" id="top"><nav class="side" id="side" aria-label="Contents">${nav.join('')}</nav><main>${B.join('\n')}</main></div>
</body>
</html>
`;
}

/** every code of MANDATE_DENY_DOCS is rendered by the guide; exported so a test can assert it */
export const documentedMandateReasons = (): string[] => Object.keys(MANDATE_DENY_DOCS);

// ------------------------------------------------------------------------------------------------------------------ the page's script (served as a file)
export const REFERENCE_JS = `// SP Trading API reference — comfort only: the page is complete without this file.
(function () {
  'use strict';
  var root = document.documentElement, store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  root.classList.remove('no-js'); root.classList.add('js');
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }

  // theme: light by default, remembered
  var theme = store.get('spw-docs-theme');
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  $('#theme').addEventListener('click', function () { var t = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', t); store.set('spw-docs-theme', t); });

  // navigation drawer (narrow screens)
  var menu = $('#menu');
  function nav(open) { root.classList.toggle('nav-open', open); menu.setAttribute('aria-expanded', String(open)); }
  menu.addEventListener('click', function () { nav(!root.classList.contains('nav-open')); });
  $('#scrim').addEventListener('click', function () { nav(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') nav(false); if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); } });

  // a link to an operation (or to an error, or to anything inside a closed block) opens what holds it
  function reveal() {
    var id = decodeURIComponent(location.hash.slice(1)); if (!id) return;
    var el = document.getElementById(id); if (!el) return;
    for (var p = el; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
    el.scrollIntoView();
    $$('nav.side a').forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + id); });
  }
  window.addEventListener('hashchange', reveal);
  $('#side').addEventListener('click', function (e) { if (e.target.closest('a')) nav(false); });

  // code: copy buttons, and tabs that remember the language across the page
  $$('.code').forEach(function (box) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'copy'; b.textContent = 'Copy';
    b.addEventListener('click', function () {
      var text = $('pre', box).textContent, done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { b.textContent = 'Select and copy'; });
      else { var r = document.createRange(); r.selectNodeContents($('pre', box)); var s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch (e) { b.textContent = 'Select and copy'; } }
    });
    var h = $('.code-h', box); if (h) h.appendChild(b); else box.appendChild(b);
  });
  function pick(label) {
    $$('.tabs').forEach(function (g) {
      var tabs = $$(':scope > .tab', g), has = tabs.some(function (t) { return t.getAttribute('data-tab') === label; }), want = has ? label : tabs[0].getAttribute('data-tab');
      tabs.forEach(function (t) { t.hidden = t.getAttribute('data-tab') !== want; });
      $$(':scope > .tabbar button', g).forEach(function (x) { x.setAttribute('aria-selected', String(x.textContent === want)); });
    });
  }
  $$('.tabs').forEach(function (g) {
    var bar = document.createElement('div'); bar.className = 'tabbar'; bar.setAttribute('role', 'tablist');
    $$(':scope > .tab', g).forEach(function (t) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.textContent = t.getAttribute('data-tab');
      b.addEventListener('click', function () { var y = b.getBoundingClientRect().top; store.set('spw-docs-lang', b.textContent); pick(b.textContent); window.scrollBy(0, b.getBoundingClientRect().top - y); });
      bar.appendChild(b);
    });
    g.insertBefore(bar, g.firstChild);
  });
  pick(store.get('spw-docs-lang') || 'curl');

  // search: operations (method, path, id, summary, permission) and the error catalogue
  var q = $('#q'), ops = $$('.op'), errs = $$('#error-catalogue .f'), links = $$('nav.side a[data-op]'), tags = $$('.tag'), guide = $$('section.g:not(#error-catalogue)'), none = $('#no-match');
  function filter() {
    var words = q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean), on = words.length > 0, shown = 0, shownErr = 0;
    function hit(el) { var s = el.getAttribute('data-search'); return words.every(function (w) { return s.indexOf(w) !== -1; }); }
    ops.forEach(function (o) { var ok = !on || hit(o); if (ok) shown++; if (ok) o.removeAttribute('data-hide'); else o.setAttribute('data-hide', ''); });
    errs.forEach(function (e) { var ok = !on || hit(e); if (ok) shownErr++; if (ok) e.removeAttribute('data-hide'); else e.setAttribute('data-hide', ''); });
    links.forEach(function (a) { var o = document.getElementById('op-' + a.getAttribute('data-op')); if (o.hasAttribute('data-hide')) a.setAttribute('data-hide', ''); else a.removeAttribute('data-hide'); });
    tags.forEach(function (t) { if ($$('.op:not([data-hide])', t).length) t.removeAttribute('data-hide'); else t.setAttribute('data-hide', ''); });
    guide.forEach(function (g) { if (on) g.setAttribute('data-hide', ''); else g.removeAttribute('data-hide'); });
    var cat = $('#error-catalogue'); if (on && !shownErr) cat.setAttribute('data-hide', ''); else cat.removeAttribute('data-hide');
    none.classList.toggle('show', on && !shown && !shownErr);
  }
  q.addEventListener('input', filter);
  reveal();
})();
`;
