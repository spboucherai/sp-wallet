import { QueryClient, QueryClientProvider, timeoutManager } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary, watchChunkErrors } from './ErrorBoundary';
import { loadLocale } from './i18n-load';
import { inBackground, watchUserInput } from './api';
import { applyTheme, cachedTheme } from './theme';
import './styles.css';

// NEXT: a short in-memory retention (5 min) instead of `gcTime: 0` — coming back to a screen shows what was read (and refreshes
// it) instead of starting from a skeleton. Nothing is persisted, and nothing outlives the session: the cache is emptied on
// lock, on logout, on a 401 and whenever the server says the session is gone (App.tsx).
const CACHE_MS = 5 * 60_000;
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5000, gcTime: CACHE_MS } } });
watchChunkErrors();
// NEXT — `X-SPW-Interaction` (api.ts): the owner's real inputs are tracked, and every TIMED re-read of a query (`refetchInterval`)
// runs as a background task, so that a tab left open keeps reading but no longer keeps the session alive by itself.
watchUserInput();
timeoutManager.setTimeoutProvider({
  setTimeout: (cb, ms) => window.setTimeout(cb, ms), clearTimeout: (id) => window.clearTimeout(id as number | undefined),
  setInterval: (cb, ms) => window.setInterval(() => inBackground(cb), ms), clearInterval: (id) => window.clearInterval(id as number | undefined),
});
// Development only: `?mock=1` simulates the derivatives API in the browser (recorded fixtures, no backend). `import.meta.env.DEV`
// is the constant `false` in a production build, so this block and the mock module are removed from the bundle.
if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search);
  if (q.get('mock') === '1') sessionStorage.setItem('spw-mock', q.get('empty') === '1' ? 'empty' : '1');
  else if (q.get('mock') === '0') sessionStorage.removeItem('spw-mock');
  if (sessionStorage.getItem('spw-mock') !== null) (await import('./derivatives/mock')).installMock();
}
applyTheme(cachedTheme()); // before the session is known: this device's cache of the account's choice (light when it has none)
// v10: the texts of the owner's language (one chunk per language) are there before anything is drawn
await loadLocale(localStorage.getItem('spw-locale') === 'en' ? 'en' : 'fr');
// Development only: /__icons shows every logo of the set on one page (src/IconWall.tsx); removed from the production bundle.
if (import.meta.env.DEV && location.pathname === '/__icons') {
  const { IconWall } = await import('./IconWall');
  createRoot(document.getElementById('root')!).render(<IconWall />);
} else
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary scope="app"><QueryClientProvider client={qc}><App /></QueryClientProvider></ErrorBoundary></StrictMode>);
