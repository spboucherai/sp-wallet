/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/nft/src/sniff.ts
 * Module           : nft
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

// Content sniffing for the media proxy (brief §7): what a file IS is decided from its first bytes; the Content-Type header a
// remote server sends is only compared with it. A file whose bytes are not one of the allow-listed formats is never served; a
// file announced as one kind (image/…) whose bytes are another kind (HTML, script) is refused as mislabelled. Pure.
import type { MediaKind } from './model.ts';

export interface Sniffed { mime: string; kind: MediaKind }
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));
const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, k) => b[at + k] === x);

/** The allow-list: every MIME type the proxy can serve, with how the web app renders it. */
export const SERVED_MIME: Record<string, MediaKind> = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image', 'image/avif': 'image', 'image/svg+xml': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/ogg': 'audio', 'audio/mp4': 'audio',
  'text/html': 'html', 'model/gltf-binary': 'model',
};

/** Text prefix with BOM, whitespace, XML declaration, comments and doctype skipped — lower-cased. */
function textHead(b: Uint8Array): string | null {
  const n = Math.min(b.length, 2048);
  let s: string;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(0, n)); } catch { try { s = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(0, Math.max(0, n - 3))); } catch { return null; } }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(s)) return null;
  return s.replace(/^﻿/, '').toLowerCase();
}
export function sniff(b: Uint8Array): Sniffed | null {
  const as = (mime: string): Sniffed => ({ mime, kind: SERVED_MIME[mime]! });
  if (b.length < 4) return null;
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return as('image/png');
  if (starts(b, [0xff, 0xd8, 0xff])) return as('image/jpeg');
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return as('image/gif');
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) { const t = ascii(b, 8, 12); if (t === 'WEBP') return as('image/webp'); if (t === 'WAVE') return as('audio/wav'); return null; }
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'avif' || brand === 'avis') return as('image/avif');
    if (brand === 'M4A ' || brand === 'M4B ') return as('audio/mp4');
    if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'mmp4', 'MSNV'].includes(brand)) return as('video/mp4');
    return null;
  }
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return as('video/webm');
  if (ascii(b, 0, 4) === 'OggS') return as('audio/ogg');
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0)) return as('audio/mpeg');
  if (ascii(b, 0, 4) === 'glTF') return as('model/gltf-binary');
  const t = textHead(b);
  if (t === null) return null;
  // skip XML declaration, comments, doctype and whitespace to the first element
  let s = t.trimStart(), doctypeHtml = false;
  for (let guard = 0; guard < 8; guard++) {
    if (s.startsWith('<?xml')) { const e = s.indexOf('?>'); if (e < 0) break; s = s.slice(e + 2).trimStart(); }
    else if (s.startsWith('<!--')) { const e = s.indexOf('-->'); if (e < 0) break; s = s.slice(e + 3).trimStart(); }
    else if (s.startsWith('<!doctype')) { doctypeHtml ||= /^<!doctype\s+html/.test(s); const e = s.indexOf('>'); if (e < 0) break; s = s.slice(e + 1).trimStart(); }
    else break;
  }
  if (/^<svg[\s>]/.test(s) && !doctypeHtml) return as('image/svg+xml');
  if (doctypeHtml || /^<(html|head|body|script|iframe|meta|title|div|canvas|style|link|p|h1)[\s>/]/.test(s)) return as('text/html');
  return null;
}

export type MediaRefusal = 'unsupported_type' | 'mime_mismatch';
/**
 * Decide what a fetched file is served as. `declared` is the remote Content-Type (may be absent or generic).
 * - bytes not recognised → `unsupported_type`;
 * - declared as image / video / audio but the bytes are of another KIND → `mime_mismatch` (a "PNG" that is HTML is refused, not rendered);
 * - otherwise the sniffed type is the answer (the declared subtype is not trusted: image/png bytes announced as image/jpeg are served as image/png).
 */
export function decideMedia(declared: string | null | undefined, bytes: Uint8Array): { ok: true; mime: string; kind: MediaKind } | { ok: false; code: MediaRefusal } {
  const s = sniff(bytes);
  if (!s) return { ok: false, code: 'unsupported_type' };
  const d = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  const dk = d.startsWith('image/') ? 'image' : d.startsWith('video/') ? 'video' : d.startsWith('audio/') ? 'audio' : d === 'text/html' || d === 'application/xhtml+xml' ? 'html' : null;
  if (dk && dk !== s.kind && !(dk === 'video' && s.kind === 'audio') && !(dk === 'audio' && s.kind === 'video')) return { ok: false, code: 'mime_mismatch' };
  return { ok: true, mime: s.mime, kind: s.kind };
}
/** Kind announced by a metadata document (`properties.files[].type`, or a file extension) — a hint for the gallery before the file is fetched; never trusted for rendering. */
export function declaredKind(mime: string | null | undefined): MediaKind {
  const d = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return SERVED_MIME[d] ?? (d.startsWith('image/') ? 'image' : d.startsWith('video/') ? 'video' : d.startsWith('audio/') ? 'audio' : d.startsWith('model/') ? 'model' : 'unknown');
}
