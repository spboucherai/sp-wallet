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
