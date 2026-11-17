// NFT metadata documents (creator-declared data, category 2 of the brief): bounded parsing and normalisation of the two common
// schemas — Metaplex JSON (name, description, image, animation_url, external_url, attributes, properties.files) and the ERC-721 /
// ERC-1155 metadata JSON (same top-level names; OpenSea-style `attributes` with display_type / max_value). Pure.
//
// Nothing is invented and nothing is dropped: every entry of `attributes` is kept (duplicates and malformed entries included) with
// its raw form; a field of the wrong type is null in the normalised view and still present in `raw`. Text is plain text: control
// characters and bidirectional overrides are removed from the normalised strings (they are a spoofing vector), HTML is not
// interpreted anywhere — the web app renders these strings as text nodes.
import type { NftAttribute } from './model.ts';

export const MAX_METADATA_BYTES = 256 * 1024, MAX_JSON_DEPTH = 12, MAX_JSON_NODES = 20_000, MAX_ATTRIBUTES = 500;
export type JsonRefusal = 'json_too_large' | 'json_too_deep' | 'json_too_many_nodes' | 'json_malformed' | 'json_not_object';

/** Parse with limits checked BEFORE the parser runs (depth, by scanning brackets outside strings) and after (node count). */
export function parseBoundedJson(text: string, o: { maxBytes?: number; maxDepth?: number; maxNodes?: number } = {}): { ok: true; value: Record<string, unknown> } | { ok: false; code: JsonRefusal } {
  const maxBytes = o.maxBytes ?? MAX_METADATA_BYTES, maxDepth = o.maxDepth ?? MAX_JSON_DEPTH, maxNodes = o.maxNodes ?? MAX_JSON_NODES;
  if (text.length > maxBytes) return { ok: false, code: 'json_too_large' };
  let depth = 0, inStr = false, esc = false;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) { if (++depth > maxDepth) return { ok: false, code: 'json_too_deep' }; }
    else if (c === 125 || c === 93) depth--;
  }
  let v: unknown;
  try { v = JSON.parse(text.replace(/^﻿/, '')); } catch { return { ok: false, code: 'json_malformed' }; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'json_not_object' };
  let nodes = 0;
  const walk = (x: unknown): boolean => { if (++nodes > maxNodes) return false; if (x && typeof x === 'object') for (const y of Object.values(x as object)) if (!walk(y)) return false; return true; };
  if (!walk(v)) return { ok: false, code: 'json_too_many_nodes' };
  return { ok: true, value: v as Record<string, unknown> };
}

// C0/C1 controls except tab and newline; bidi embeddings/overrides/isolates; zero-width joiners are kept (emoji), BOM removed
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]/g;
/** A plain-text field: a string (or a finite number), cleaned and clipped; anything else is null. */
export function plainText(v: unknown, max: number): string | null {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
  if (s === null) return null;
  const t = s.replace(/\0+$/, '').replace(UNSAFE_TEXT, '').trim();
  return t ? (t.length > max ? `${t.slice(0, max)}…` : t) : null;
}

export function normaliseAttributes(raw: unknown): NftAttribute[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ATTRIBUTES).map((e): NftAttribute => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { raw: e, traitType: null, value: null, valueText: typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean' ? String(e) : '', displayType: null, maxValue: null, malformed: true };
    const o = e as Record<string, unknown>, v = o.value;
    const value = typeof v === 'string' || typeof v === 'boolean' || v === null ? v : typeof v === 'number' && Number.isFinite(v) ? v : null;
    const okValue = 'value' in o && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null);
    return { raw: e, traitType: plainText(o.trait_type, 120), value: typeof value === 'string' ? value.replace(UNSAFE_TEXT, '') : value,
      valueText: value === null ? '' : typeof value === 'string' ? (plainText(value, 500) ?? '') : String(value),
      displayType: plainText(o.display_type, 40), maxValue: typeof o.max_value === 'number' && Number.isFinite(o.max_value) ? String(o.max_value) : plainText(o.max_value, 40), malformed: !okValue };
  });
}

export interface NormalisedMetadata {
  name: string | null; description: string | null; externalUrl: string | null; attributes: NftAttribute[];
  /** URIs as written in the document (not resolved, not validated here) */
  image: string | null; animationUrl: string | null;
  files: { uri: string; type: string | null }[];
  /** `collection.name` of a Metaplex document, kept apart: it is a claim of the item, not a verified collection */
  declaredCollectionName: string | null;
}
const str = (v: unknown, max = 2048): string | null => (typeof v === 'string' && v.trim() && v.length <= max * 200 ? v.trim() : null);
export function normaliseMetadata(doc: Record<string, unknown>): NormalisedMetadata {
  const props = doc.properties && typeof doc.properties === 'object' && !Array.isArray(doc.properties) ? (doc.properties as Record<string, unknown>) : {};
  const files = (Array.isArray(props.files) ? props.files : []).slice(0, 20).flatMap((f): { uri: string; type: string | null }[] => {
    if (typeof f === 'string') return [{ uri: f, type: null }];
    const o = f as Record<string, unknown> | null, uri = o && str(o.uri);
    return uri ? [{ uri, type: plainText(o!.type, 80) }] : [];
  });
  const coll = doc.collection && typeof doc.collection === 'object' ? (doc.collection as Record<string, unknown>) : null;
  return {
    name: plainText(doc.name, 300), description: plainText(doc.description, 5000),
    externalUrl: str(doc.external_url) ?? str(doc.external_link), attributes: normaliseAttributes(doc.attributes ?? doc.traits),
    image: str(doc.image) ?? str(doc.image_url) ?? str(doc.image_data && typeof doc.image_data === 'string' && /^<svg/i.test(doc.image_data.trim()) ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(doc.image_data)))}` : null),
    animationUrl: str(doc.animation_url), files, declaredCollectionName: coll ? plainText(coll.name, 200) : null,
  };
}
