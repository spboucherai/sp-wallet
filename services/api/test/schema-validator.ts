// The OpenAPI document as a validator — JSON Schema 2020-12, the subset zod emits (type, properties, required,
// additionalProperties, items, prefixItems, enum, const, anyOf, pattern) and `$ref` into the document. No dependency: `ajv`
// is in the tree only as a transitive dependency of Fastify (pnpm does not expose it to this package), and the trading
// contract test already validates with a function of this size.
//
// `strict` is what makes a DESCRIPTIVE contract binding: with it,
//   - an object that declares members refuses a member it does not declare (the API's objects are open on the wire, so
//     without this a response could grow members the document never heard of);
//   - a value of an OPEN enumeration (`x-spw-open` with `x-spw-values`) must be one of its known values: the server itself
//     (or carry one of its documented prefixes, `x-spw-value-prefixes`): the server itself may not answer a value its own
//     document does not list.
// An object schema without declared members is a free-form payload (documented with its own family) and is not inspected.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ValidateOptions { strict?: boolean }

export function violations(doc: any, schema: any, value: unknown, o: ValidateOptions = {}, at = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema.$ref) {
    const target = String(schema.$ref).split('/').slice(1).reduce((x: any, k: string) => x?.[k], doc);
    if (!target) return [`${at}: unresolved ${schema.$ref}`];
    return violations(doc, target, value, o, at);
  }
  if (schema.anyOf) {
    const tries = (schema.anyOf as any[]).map((s) => violations(doc, s, value, o, at));
    if (tries.some((t) => t.length === 0)) return [];
    const best = tries.sort((a, b) => a.length - b.length)[0]!;
    return [`${at}: matches no alternative — closest: ${best.slice(0, 4).join(' ; ')}`];
  }
  if ('const' in schema) return value === schema.const ? [] : [`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)?.slice(0, 60)}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  const types: string[] = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const is = (t: string): boolean => (t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : t === 'integer' ? Number.isInteger(value) : t === 'number' ? typeof value === 'number' : typeof value === t);
  if (types.length && !types.some(is)) return [`${at}: expected ${types.join('|')}, got ${JSON.stringify(value)?.slice(0, 60)}`];
  const out: string[] = [];
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: does not match ${schema.pattern}`);
    if (o.strict && schema['x-spw-open'] === true && Array.isArray(schema['x-spw-values']) && !schema['x-spw-values'].includes(value) && !(schema['x-spw-value-prefixes'] ?? []).some((p: string) => value.startsWith(p))) out.push(`${at}: ${JSON.stringify(value)} is not a documented value of this enumeration`);
  }
  if (Array.isArray(value)) {
    if (schema.prefixItems) { schema.prefixItems.forEach((s: any, i: number) => out.push(...violations(doc, s, value[i], o, `${at}[${i}]`))); if (schema.items === false && value.length > schema.prefixItems.length) out.push(`${at}: too many items`); }
    else if (schema.items) value.forEach((x, i) => out.push(...violations(doc, schema.items, x, o, `${at}[${i}]`)));
  } else if (value !== null && typeof value === 'object') {
    const props = schema.properties ?? {}, declared = Object.keys(props).length > 0, extra = schema.additionalProperties, rec = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in rec)) out.push(`${at}.${k}: required`);
    for (const [k, x] of Object.entries(rec)) {
      if (props[k]) out.push(...violations(doc, props[k], x, o, `${at}.${k}`));
      else if (extra === false) out.push(`${at}.${k}: not declared (the object is closed)`);
      else if (extra && typeof extra === 'object' && Object.keys(extra).length) out.push(...violations(doc, extra, x, o, `${at}.${k}`)); // a map: every value of one schema
      else if (o.strict && declared) out.push(`${at}.${k}: returned by the server but not declared in the contract`);
    }
  }
  return out;
}
