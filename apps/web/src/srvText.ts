// v11 interface (audit B3 remainder). Kept OUT of sv.ts on purpose: sv.ts is part of the first chunk (Home's price freshness
// uses it) and this function brings reasonTexts.ts — the table of known server sentences — which only the lazily loaded
// screens need (agents, research, system status).
import { hasText } from './i18n';
import { reasonKnown, reasonText } from './reasonTexts';
import { svText, type T } from './sv';

/**
 * v11 interface (audit B3 remainder) — a sentence the server wrote in English WITHOUT a code (agent holds and stops, research
 * refusals, withdrawal errors, what a connector measured). On an English screen it is shown as it is. On a French screen: its
 * French wording when the sentence is one the server is known to write (reasonTexts.ts); otherwise it is shown as what it is —
 * a quotation of the server, marked as English — and never as if it were a sentence of the interface.
 */
export function srvText(t: T, locale: string, text: string | null | undefined, code?: string | null): string {
  if (!text) return code ?? '';
  if (code && (hasText(`sv_${code}`) || hasText(`e_${code}`))) return svText(t, code, null, text);
  if (locale !== 'fr') return text;
  return reasonKnown(text) ? reasonText(text, locale) : t('v11LoSrvQuote', { text });
}
