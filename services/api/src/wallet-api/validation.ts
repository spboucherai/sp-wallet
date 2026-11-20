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
