/**
 * NEXT — appearance: `system` (follows the device, `prefers-color-scheme`), `light` or `dark`.
 *
 * The choice belongs to the ACCOUNT (`theme` in GET/PUT /settings): it is applied on every device once the session is open.
 * localStorage (`spw-theme`) is only the cache used BEFORE the session is known (lock screen, first paint); a device that has
 * no cache yet starts light. `<html data-theme>` carries the choice (tokens.css resolves `system` with a media query);
 * `<html data-scheme>` carries what is actually shown (light | dark), for the few rules and scripts that need the result.
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';
export const THEME_KEY = 'spw-theme';
export const isThemePref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark';
/** what a preference shows on a device whose own preference is `systemDark` (pure: tested) */
export const resolveScheme = (pref: ThemePref, systemDark: boolean): Scheme => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref);

const media = (): MediaQueryList | null => { try { return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null; } catch { return null; } };
let current: ThemePref = 'light', watching = false;
function paint(): void {
  const scheme = resolveScheme(current, !!media()?.matches), el = document.documentElement;
  el.dataset.theme = current; el.dataset.scheme = scheme;
  // the browser chrome takes the page background of the scheme shown (the `bg` token as the page resolves it)
  const bg = typeof getComputedStyle === 'function' ? getComputedStyle(el).getPropertyValue('--bg').trim() : '';
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
export function applyTheme(pref: ThemePref): void {
  current = pref; paint();
  if (!watching) { watching = true; media()?.addEventListener?.('change', paint); }   // `system` follows the device live
}
export const cachedTheme = (): ThemePref => { try { const v = localStorage.getItem(THEME_KEY); return isThemePref(v) ? v : 'light'; } catch { return 'light'; } };
export function cacheTheme(pref: ThemePref): void { try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode: the account still has it */ } }
export const currentTheme = (): ThemePref => current;
