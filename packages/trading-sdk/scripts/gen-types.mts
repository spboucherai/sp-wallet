/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/scripts/gen-types.mts
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

// Generates src/generated/openapi.ts from docs/openapi/trading-v1.json (the contract of the SP Trading API).
//   node packages/trading-sdk/scripts/gen-types.mts            write the file
//   node packages/trading-sdk/scripts/gen-types.mts --check    exit 1 when the committed file is not what the document gives
// No dependency: the document only uses the JSON Schema 2020-12 subset that zod emits (type, properties, required,
// additionalProperties, items, prefixItems, enum, const, anyOf) and `$ref` to `#/components/schemas/<name>` (a named type);
// anything else makes the generator throw rather than guess.
// A test (test/generated.test.ts) runs `generate` and compares with the committed file.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OPENAPI_PATH = path.resolve(HERE, '../../../docs/openapi/trading-v1.json');
export const OUTPUT_PATH = path.resolve(HERE, '../src/generated/openapi.ts');

const KNOWN = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'enum', 'const', 'anyOf', '$ref', 'propertyNames', 'description', 'default', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
const ident = (k: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const doc = (s: Json, pad: string): string => {
  const parts = [typeof s.description === 'string' ? s.description : '', typeof s.pattern === 'string' ? `pattern: ${s.pattern}` : '', s.default !== undefined ? `default: ${JSON.stringify(s.default)}` : ''].filter(Boolean);
  return parts.length ? `${pad}/** ${parts.join(' — ').replace(/\*\//g, '*\\/')} */\n` : '';
};

/** JSON Schema → TypeScript type expression */
export function tsType(s: unknown, pad = ''): string {
  if (s === true) return 'unknown';
  if (s === false) return 'never';
  if (typeof s !== 'object' || s === null) throw new Error(`unsupported schema: ${JSON.stringify(s)}`);
  const j = s as Json;
  for (const k of Object.keys(j)) if (!KNOWN.has(k)) throw new Error(`unsupported JSON Schema keyword '${k}' — extend gen-types.mts`);
  if (typeof j.$ref === 'string') {
    const m = /^#\/components\/schemas\/([A-Za-z][A-Za-z0-9]*)$/.exec(j.$ref);
    if (!m) throw new Error(`unsupported $ref '${j.$ref}' — only #/components/schemas/<name>`);
    return componentName(m[1]!);
  }
  if ('const' in j) return JSON.stringify(j.const);
  if (Array.isArray(j.enum)) return j.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(j.anyOf)) return j.anyOf.map((x) => { const t = tsType(x, pad); return t.includes('=>') ? `(${t})` : t; }).join(' | ');
  if (Array.isArray(j.type)) return j.type.map((t) => tsType({ ...j, type: t }, pad)).join(' | ');
  switch (j.type) {
    case undefined: return 'unknown';
    case 'string': return 'string';
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': {
      if (Array.isArray(j.prefixItems)) {
        if (j.items !== false) throw new Error('open tuples are not supported');
        return `[${j.prefixItems.map((x) => tsType(x, pad)).join(', ')}]`;
      }
      const t = tsType(j.items ?? true, pad);
      return /[|&]/.test(t) && !t.startsWith('{') ? `Array<${t}>` : `${t}[]`;
    }
    case 'object': {
      const props = (j.properties ?? {}) as Record<string, Json>, required = new Set((j.required as string[] | undefined) ?? []);
      const open = j.additionalProperties !== false; // absent, true or {} = extra members are allowed
      const keys = Object.keys(props);
      if (j.propertyNames !== undefined && JSON.stringify(j.propertyNames) !== '{"type":"string"}') throw new Error('only string property names are supported');
      // a map (zod's z.record): no named member, every value of one schema
      if (!keys.length && j.additionalProperties !== null && typeof j.additionalProperties === 'object' && Object.keys(j.additionalProperties).length) return `Record<string, ${tsType(j.additionalProperties, pad)}>`;
      if (!keys.length) return open ? 'Record<string, unknown>' : 'Record<string, never>';
      const inner = pad + '  ';
      const lines = keys.map((k) => `${doc(props[k]!, inner)}${inner}${ident(k)}${required.has(k) ? '' : '?'}: ${tsType(props[k], inner)};`);
      if (open) lines.push(`${inner}[extra: string]: unknown;`);
      return `{\n${lines.join('\n')}\n${pad}}`;
    }
    default: throw new Error(`unsupported type ${JSON.stringify(j.type)}`);
  }
}

const pascal = (id: string): string => id[0]!.toUpperCase() + id.slice(1);
/** TypeScript name of a component schema: its own name, except the error body (kept as `ApiErrorBody`) */
export const componentName = (name: string): string => (name === 'Error' ? 'ApiErrorBody' : name);
interface Op { id: string; method: string; path: string; o: Json }

export function generate(document: Json): string {
  const ops: Op[] = [];
  for (const [p, item] of Object.entries(document.paths as Record<string, Record<string, Json>>)) for (const [method, o] of Object.entries(item)) ops.push({ id: o.operationId as string, method: method.toUpperCase(), path: p, o });
  const L: string[] = [];
  L.push('// GENERATED by packages/trading-sdk/scripts/gen-types.mts from docs/openapi/trading-v1.json — do not edit.',
    '// A test compares this file with what the generator gives for the committed OpenAPI document.', '/* eslint-disable */', '');
  L.push(`export const API_VERSION = ${JSON.stringify((document.info as Json).version)};`, '');
  const scopes = document['x-spw-scopes'] as { scope: string; execution: boolean }[];
  L.push(`export const SCOPES = [${scopes.map((s) => JSON.stringify(s.scope)).join(', ')}] as const;`, 'export type Scope = (typeof SCOPES)[number];',
    `/** inert on a key that is not bound to a trading mandate (403 \`mandate_required\`) */`, `export const EXECUTION_SCOPES = [${scopes.filter((s) => s.execution).map((s) => JSON.stringify(s.scope)).join(', ')}] as const;`, '');
  const events = document['x-spw-webhook-events'] as { event: string; emitted: boolean }[];
  L.push(`export const WEBHOOK_EVENTS = [${events.map((e) => JSON.stringify(e.event)).join(', ')}] as const;`, 'export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];', '');
  const states = document['x-spw-order-states'] as { state: string; final: boolean }[];
  L.push('/** the states of the unified order state machine — the closed set of `status` */', `export const ORDER_STATES = [${states.map((x) => JSON.stringify(x.state)).join(', ')}] as const;`, 'export type OrderState = (typeof ORDER_STATES)[number];',
    '/** UNKNOWN is not among them: it is neither final nor a failure */', `export const FINAL_ORDER_STATES = [${states.filter((x) => x.final).map((x) => JSON.stringify(x.state)).join(', ')}] as const;`,
    '/** `data.reasons` of a `mandate_denied` refusal */', `export const MANDATE_DENY_REASONS = [${(document['x-spw-mandate-deny-reasons'] as string[]).map((x) => JSON.stringify(x)).join(', ')}] as const;`,
    '/** ids of the risk checks (`data.failed`, `data.checks[].id`, `risk.checks[].id` of a preview) */', `export const RISK_CHECK_IDS = [${(document['x-spw-risk-checks'] as string[]).map((x) => JSON.stringify(x)).join(', ')}] as const;`, '');
  L.push(`// ${'-'.repeat(100)} components`);
  for (const [name, schema] of Object.entries((document.components as Json).schemas as Record<string, Json>)) L.push(`${doc(schema, '')}export type ${componentName(name)} = ${tsType(schema)};`);
  L.push('');

  for (const { id, method, path: p, o } of ops) {
    const P = pascal(id), params = (o.parameters ?? []) as Json[];
    const query = params.filter((x) => x.in === 'query');
    L.push(`// ${'-'.repeat(100)} ${id}: ${method} ${p}`);
    if (query.length) {
      L.push(`export interface ${P}Query {`);
      for (const q of query) L.push(`${doc({ ...(q.schema as Json), ...(q.description ? { description: q.description } : {}) }, '  ')}  ${ident(q.name as string)}${q.required ? '' : '?'}: ${tsType(Object.fromEntries(Object.entries(q.schema as Json).filter(([k]) => k !== 'default')), '  ')};`);
      L.push('}');
    }
    const body = ((o.requestBody as Json | undefined)?.content as Json | undefined)?.['application/json'] as Json | undefined;
    if (body) L.push(`export type ${P}Body = ${tsType(body.schema)};`);
    const ok = (((o.responses as Json)['200'] as Json | undefined)?.content as Json | undefined)?.['application/json'] as Json | undefined;
    if (ok) L.push(`export type ${P}Response = ${tsType(ok.schema)};`);
    L.push('');
  }

  L.push('/** every operation of the document: method, path template, scope, whether the server implements it, and whether it is a mutating (idempotent-keyed) call */',
    'export const OPERATIONS = {');
  for (const { id, method, path: p, o } of ops) {
    const params = (o.parameters ?? []) as Json[];
    L.push(`  ${id}: { method: ${JSON.stringify(method)}, path: ${JSON.stringify(p)}, scope: ${JSON.stringify(o['x-spw-scope'])}, implemented: ${String(o['x-spw-implemented'] === true)}, ` +
      `idempotent: ${String(params.some((x) => x.in === 'header' && x.name === 'Idempotency-Key' && x.required === true))}, requiresMandate: ${String(o['x-spw-requires-mandate'] === true)}, ` +
      `statuses: [${Object.keys(o.responses as Json).sort().join(', ')}], errorsOpen: ${String(o['x-spw-errors-open'] === true)} },`);
  }
  L.push('} as const;', 'export type OperationId = keyof typeof OPERATIONS;', '');
  L.push('/** every error answer an operation can give: `[HTTP status, code]` (the document\'s `x-spw-errors`) */', 'export const OPERATION_ERRORS: Record<OperationId, readonly (readonly [number, string])[]> = {');
  for (const { id, o } of ops) L.push(`  ${id}: [${(o['x-spw-errors'] as { status: number; code: string }[]).map((e) => `[${e.status}, ${JSON.stringify(e.code)}]`).join(', ')}],`);
  L.push('};', '');
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = generate(JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as Json);
  if (process.argv.includes('--check')) {
    const have = (() => { try { return readFileSync(OUTPUT_PATH, 'utf8'); } catch { return ''; } })();
    if (have !== out) { console.error('packages/trading-sdk/src/generated/openapi.ts is out of date: run `node packages/trading-sdk/scripts/gen-types.mts`'); process.exit(1); }
    console.log('src/generated/openapi.ts is up to date');
  } else { writeFileSync(OUTPUT_PATH, out); console.log(`wrote ${path.relative(process.cwd(), OUTPUT_PATH)} (${out.length} bytes)`); }
}
