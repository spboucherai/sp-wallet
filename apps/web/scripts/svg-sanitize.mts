/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/scripts/svg-sanitize.mts
 * Module           : web
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

// An SVG is code. Every logo shipped with the wallet goes through this file: `cleanSvg` removes what a logo never needs
// (prolog, doctype, comments, metadata, editor attributes), `unsafeReason` refuses what could load or run anything
// (script, foreignObject, embedded or remote images, event handlers, external references, entities). The icons are only ever
// rendered through <img>, where a browser runs no script and loads no sub-resource: this is a second, independent barrier.

/** Canonical form of a logo. Idempotent: cleanSvg(cleanSvg(x)) === cleanSvg(x). Throws when the file is not an SVG. */
export function cleanSvg(src: string): string {
  let s = src.replace(/^﻿/, '');
  if (/<!ENTITY/i.test(s)) throw new Error('entity declaration');
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(metadata|title|desc)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<(metadata|title|desc)\b[^>]*\/>/gi, '');
  s = s.replace(/<(sodipodi|inkscape):[\w-]+\b[^>]*?(\/>|>[\s\S]*?<\/\1:[\w-]+\s*>)/gi, '');
  s = s.replace(/\s+(?:xmlns:(?:sodipodi|inkscape|dc|cc|rdf|svg|sketch|serif|xodm)|(?:sodipodi|inkscape|sketch|serif|xodm):[\w-]+|data-[\w-]+|xml:space|enable-background)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  s = s.replace(/>\s+</g, '><').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  const m = /^<svg\b([^>]*)>/i.exec(s);
  if (!m || !/<\/svg>$/i.test(s)) throw new Error('not an <svg> document');
  if (!/\bviewBox\s*=/.test(m[1]!)) {
    const w = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/.exec(m[1]!), h = /\bheight\s*=\s*["']([\d.]+)(?:px)?["']/.exec(m[1]!);
    if (!w || !h) throw new Error('no viewBox and no numeric width/height');
    s = s.replace(/^<svg\b/i, `<svg viewBox="0 0 ${w[1]} ${h[1]}"`);
  }
  return s + '\n';
}

const FORBIDDEN: [RegExp, string][] = [
  [/<\s*script\b/i, '<script>'], [/<\s*foreignObject\b/i, '<foreignObject>'], [/<\s*(iframe|object|embed|audio|video|canvas|handler|listener)\b/i, 'embedded content'],
  [/<\s*image\b/i, '<image> (embedded or remote raster)'], [/<\s*a[\s>]/i, '<a> link'], [/<\s*(animate|animateTransform|animateMotion|set)\b/i, 'animation element'],
  [/\son[a-z]+\s*=/i, 'event handler attribute'], [/(?:xlink:)?href\s*=\s*["']\s*(?!#)/i, 'href that is not a local #fragment'],
  [/url\(\s*["']?\s*(?!#)/i, 'url() that is not a local #fragment'], [/javascript:/i, 'javascript: URL'], [/data:/i, 'data: URL'],
  [/<!ENTITY|<!DOCTYPE/i, 'doctype / entity'], [/@import/i, '@import'], [/xml:base/i, 'xml:base'], [/<\?/, 'processing instruction'],
];
/** null when the SVG is acceptable; otherwise the first reason it is refused. */
export function unsafeReason(svg: string): string | null {
  for (const [re, why] of FORBIDDEN) if (re.test(svg)) return why;
  if (!/^<svg\b[^>]*\bviewBox\s*=/i.test(svg)) return 'no viewBox on the root element';
  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svg)) return 'no SVG namespace';
  return null;
}

/** Pixel size of a PNG or WebP file (null: neither). */
export function rasterSize(b: Uint8Array): { w: number; h: number; type: 'png' | 'webp' } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length > 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20), type: 'png' };
  if (b.length > 30 && tag(0, 4) === 'RIFF' && tag(8, 4) === 'WEBP') {
    const k = tag(12, 4);
    if (k === 'VP8X') return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)), type: 'webp' };
    if (k === 'VP8 ') return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff, type: 'webp' };
    if (k === 'VP8L') { const n = v.getUint32(21, true); return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff), type: 'webp' }; }
  }
  return null;
}
