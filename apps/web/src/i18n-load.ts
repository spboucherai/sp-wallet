// v10 performance pass: the texts of ONE language, as a chunk of their own (see i18n.ts and the `spw-i18n-split` plugin in
// vite.config.ts). Loaded before the first render (main.tsx) and before a change of language takes effect (App.tsx).
import { hasLocaleTable, setLocaleTable, type Locale } from './i18n';

const loaders: Record<Locale, () => Promise<{ default: Record<string, string> }>> = { fr: () => import('virtual:spw-i18n-fr'), en: () => import('virtual:spw-i18n-en') };
export async function loadLocale(l: Locale): Promise<void> {
  if (hasLocaleTable(l)) return;
  setLocaleTable(l, (await loaders[l]()).default);
}
