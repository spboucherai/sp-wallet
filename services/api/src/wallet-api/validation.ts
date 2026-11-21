/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/wallet-api/validation.ts
 * Module           : wallet-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT — what a client is told when input validation refuses a request: WHICH members, and what is expected of each.
// Before, every zod failure collapsed to `bad_request / invalid request` and a form could not point at the field.
//
// No submitted VALUE is ever written back. Each message is composed here from the issue's own constraint (expected type,
// bound, format); zod's default message is not used, because it can quote input (it names an unrecognised key, for one).
// A path locates the member to fix: a segment is kept only when it is an array index or looks like a member name (a letter,
// then letters, digits or underscores, 40 at most); anything else — a long or odd key of a free map — is shown as `*`.
import type { ZodError } from 'zod';

export interface FieldIssue { path: string; code: string; message: string }
export const MAX_FIELD_ISSUES = 20;
type Issue = ZodError['issues'][number] & Record<string, unknown>;

const SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const pathOf = (path: readonly PropertyKey[]): string => path.map((p) => (typeof p === 'number' ? String(p) : typeof p === 'string' && SEGMENT.test(p) ? p : '*')).join('.').slice(0, 120);
const word = (v: unknown): string => (typeof v === 'string' && /^[a-z_]{1,24}$/.test(v) ? v : 'value');
const bound = (v: unknown): string => (typeof v === 'number' || typeof v === 'bigint' ? String(v) : '?');

function messageOf(i: Issue): string {
  switch (i.code) {
    case 'invalid_type': return `expected ${word(i.expected)}`;
    case 'too_small': return `too small: at least ${bound(i.minimum)}${i.origin === 'string' ? ' characters' : i.origin === 'array' ? ' items' : ''}`;
    case 'too_big': return `too big: at most ${bound(i.maximum)}${i.origin === 'string' ? ' characters' : i.origin === 'array' ? ' items' : ''}`;
    case 'invalid_format': return `invalid format: expected ${word(i.format)}`;
    case 'invalid_value': return 'not one of the accepted values';
    case 'unrecognized_keys': return 'the object has a member this route does not accept';
    case 'invalid_union': return 'matches none of the accepted shapes';
    case 'not_multiple_of': return `must be a multiple of ${bound(i.divisor)}`;
    case 'invalid_key': return 'a key of this map is not accepted';
    case 'invalid_element': return 'an element is not accepted';
    // a refinement written in this code base: its sentence is ours, a constant ("nothing to change")
    case 'custom': return typeof i.message === 'string' && i.message !== 'Invalid input' && /^[A-Za-z0-9 ,.:;()'/_-]{1,120}$/.test(i.message) ? i.message : 'not accepted';
    default: return 'not accepted';
  }
}

/** The `data.fields` of a validation refusal: at most MAX_FIELD_ISSUES entries, each `{ path, code, message }`. */
export function validationFields(e: ZodError): FieldIssue[] {
  return e.issues.slice(0, MAX_FIELD_ISSUES).map((raw) => { const i = raw as Issue; return { path: pathOf(i.path), code: String(i.code).slice(0, 40), message: messageOf(i) }; });
}

// ---------------------------------------------------------------------------------------------------------------- control characters
// One rule for every route (server.ts `preValidation`), instead of a 500 from the database:
//   - a NUL (U+0000) is refused everywhere — query, path parameters, every string and every key of a JSON body. PostgreSQL
//     cannot store it in text or jsonb, and no field of this API means anything with one;
//   - any other control character (C0, DEL) is refused in the query string and in path parameters: ids, filters, searches.
// Body strings keep the other control characters: a strategy source or a captured log legitimately has tabs, new lines and
// escape sequences, and PostgreSQL stores them. The routes that want stricter text say so in their own schema.
const CONTROL = /[\u0000-\u001f\u007f]/, NUL = /\u0000/;
const issue = (path: string): FieldIssue => ({ path, code: 'invalid_format', message: 'control characters are not accepted' });
function nulIn(v: unknown, path: (string | number)[], depth: number): FieldIssue | null {
  if (typeof v === 'string') return NUL.test(v) ? issue(pathOf(path)) : null;
  if (v === null || typeof v !== 'object' || depth > 12) return null;
  for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v)) {
    if (typeof k === 'string' && NUL.test(k)) return issue(pathOf(path));
    const hit = nulIn(x, [...path, k], depth + 1);
    if (hit) return hit;
  }
  return null;
}
/** The first place where the request carries text this API refuses outright, as a `data.fields` entry; null when there is none. */
export function controlIssue(query: unknown, params: unknown, body: unknown): FieldIssue | null {
  for (const flat of [query, params]) if (flat && typeof flat === 'object') for (const [k, v] of Object.entries(flat))
    for (const x of Array.isArray(v) ? v : [v]) if ((typeof x === 'string' && CONTROL.test(x)) || CONTROL.test(k)) return issue(pathOf([k]));
  return nulIn(body, [], 0);
}
