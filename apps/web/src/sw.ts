// Service worker of SP Wallet — notifications only.
// It deliberately has NO fetch handler and no cache: every request of the wallet goes to the network as before, nothing of the
// API is ever stored by the worker, and a new release is never masked by a stale copy. Bundled to /sw.js by vite.config.ts.
import { notificationFor, safeUrl } from './sw-core';

interface SwClient { url: string; focus?: () => Promise<unknown>; postMessage(m: unknown): void }
interface SwScope {
  addEventListener(type: string, fn: (e: any) => void): void;
  skipWaiting(): Promise<void>;
  navigator: { language?: string };
  registration: { showNotification(title: string, options: unknown): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<SwClient[]>; openWindow(url: string): Promise<unknown> };
}
const sw = self as unknown as SwScope;

sw.addEventListener('install', () => { void sw.skipWaiting(); });
sw.addEventListener('activate', (e) => { e.waitUntil(sw.clients.claim()); });

sw.addEventListener('push', (e) => {
  let data: unknown = null;
  try { data = e.data ? e.data.json() : null; } catch { /* not JSON: the generic notification is shown */ }
  const n = notificationFor(data, sw.navigator.language);
  e.waitUntil(sw.registration.showNotification(n.title, n.options));
});

sw.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = safeUrl(e.notification.data?.url);
  e.waitUntil((async () => {
    const open = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = open.find((x) => typeof x.focus === 'function');
    if (c) { await c.focus!(); c.postMessage({ type: 'spw-nav', url }); return; }   // the app is open: bring it forward and navigate inside it
    await sw.clients.openWindow(url);
  })());
});
