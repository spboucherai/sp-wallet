/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/sw-core.ts
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

// Pure part of the service worker (unit-tested): from a decrypted push payload to what is shown, and where a tap leads.
// The payload carries a kind and parameters, never a sentence; the sentence is made here, in the language of the device.
import { alertPath, renderAlert, type AlertLocale, type AlertParams, type AlertSubject } from '../../../packages/core/src/alert-catalog';
import { localizeAlertParams } from './reasonTexts';

export interface PushPayload { v: 1; id: number; kind: string; sev: 'info' | 'warning' | 'critical'; ts: number; /** language chosen in the app on this device */ l?: AlertLocale; /** details allowed by the owner */ d?: boolean; p?: AlertParams; s?: AlertSubject | null }
export interface Shown { title: string; options: { body: string; tag: string; lang: string; icon: string; badge: string; timestamp?: number; requireInteraction?: boolean; data: { url: string; id: number | null } } }

export const languageOf = (payloadLang: unknown, deviceLang: string | undefined): AlertLocale =>
  payloadLang === 'fr' || payloadLang === 'en' ? payloadLang : (deviceLang ?? 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';

const isPayload = (x: unknown): x is PushPayload => !!x && typeof x === 'object' && (x as PushPayload).v === 1 && typeof (x as PushPayload).kind === 'string';

/** Always returns something to show: iOS and Chrome require a visible notification for every push (userVisibleOnly). */
export function notificationFor(raw: unknown, deviceLang?: string): Shown {
  const base = { icon: '/icon-192.png', badge: '/icon-192.png' };
  if (!isPayload(raw)) {
    const fr = languageOf(undefined, deviceLang) === 'fr';
    return { title: 'SP Wallet', options: { ...base, body: fr ? 'Nouvelle alerte. Ouvrez l’application.' : 'New alert. Open the app.', tag: 'spw', lang: fr ? 'fr' : 'en', data: { url: '/alerts', id: null } } };
  }
  const lang = languageOf(raw.l, deviceLang);
  const text = renderAlert(raw.kind, localizeAlertParams(raw.p ?? {}, lang), lang, raw.d === true);   // v8: known server reasons in the notification's language
  const title = text.title === raw.kind ? 'SP Wallet' : text.title;     // a kind this (older) worker does not know: generic title, still shown
  return { title, options: { ...base, body: text.body, tag: `spw-${raw.id || raw.kind}`, lang, timestamp: raw.ts, ...(raw.sev === 'critical' ? { requireInteraction: true } : {}),
    data: { url: text.title === raw.kind ? '/alerts' : alertPath(raw.kind, raw.s), id: raw.id || null } } };
}

/** only same-origin paths are ever opened from a notification */
export const safeUrl = (u: unknown): string => (typeof u === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(u) ? u : '/alerts');
