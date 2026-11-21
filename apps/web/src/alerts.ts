/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/alerts.ts
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

// Client side of the alerts layer: unread count (live over SSE), service worker registration and the Web Push subscription
// of THIS device. Nothing here runs unless the owner is signed in; the service worker itself only shows notifications.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, get, post } from './api';
import type { Locale } from './i18n';

export interface Unread { unread: number; critical: number; lastId: number }
export interface AlertItem { id: number; ts: number; kind: string; severity: 'info' | 'warning' | 'critical'; group: string; params: Record<string, string | number | boolean | null>; subject: { type: string; id?: string; network?: string } | null;
  count: number; readAt: number | null; delivery: string; channels: Record<string, unknown> }
export interface Device { id: string; label: string; locale: Locale; service: string; endpointTail: string; ua: string; createdAt: number; lastOkAt: number | null; lastError: string | null; failures: number }

/** unread count, pushed by the server; a slow poll covers a browser without EventSource or a proxy that buffers */
export function useUnread() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alerts-unread'], queryFn: () => get<Unread>('/alerts/unread'), refetchInterval: 60_000 });
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/alerts/stream');
    es.addEventListener('unread', (e) => {
      try {
        const u = JSON.parse((e as MessageEvent<string>).data) as Unread, prev = qc.getQueryData<Unread>(['alerts-unread']);
        qc.setQueryData(['alerts-unread'], u);
        if (!prev || prev.lastId !== u.lastId || prev.unread !== u.unread) void qc.invalidateQueries({ queryKey: ['alerts'] });
      } catch { /* ignore a malformed frame */ }
    });
    return () => es.close();
  }, [qc]);
  const n = q.data?.unread ?? 0;
  // the number on the Home Screen icon (installed PWA, iOS 16.4+ / desktop Chromium)
  useEffect(() => { const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> }; void (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {}); }, [n]);
  return q.data ?? { unread: 0, critical: 0, lastId: 0 };
}

// ---- Web Push on this device
export type PushState = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';
export const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = (): boolean => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const pushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
}
const b64u = (b: ArrayBuffer | null): string => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');
const unb64u = (s: string): Uint8Array<ArrayBuffer> => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')), out = new Uint8Array(new ArrayBuffer(bin.length)); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSubscription()) && Notification.permission === 'granted' ? 'on' : 'off';
}
export const defaultLabel = (): string => {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : 'Safari';
  return `${os} · ${br}`;
};
/** Must be called from a tap (iOS only shows the permission prompt on a user gesture). */
export async function enablePush(label: string, locale: Locale): Promise<Device> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw Object.assign(new Error('denied'), { code: 'push_denied' });
  const reg = (await registerWorker()) ?? (() => { throw Object.assign(new Error('no worker'), { code: 'push_unsupported' }); })();
  await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>('/push/key');
  let sub = await reg.pushManager.getSubscription();
  // a subscription made for another server key (the VAPID key was regenerated) cannot be reused
  if (sub && b64u(sub.options.applicationServerKey) !== publicKey) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(publicKey) });
  return post<Device>('/push/subscriptions', { endpoint: sub.endpoint, keys: { p256dh: b64u(sub.getKey('p256dh')), auth: b64u(sub.getKey('auth')) }, label, locale });
}
export async function disablePush(devices: Device[]): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const mine = devices.find((d) => sub.endpoint.endsWith(d.endpointTail));
  await sub.unsubscribe().catch(() => {});
  if (mine) await api('DELETE', `/push/subscriptions/${mine.id}`);
}
export const thisDevice = async (devices: Device[]): Promise<Device | null> => { const sub = await currentSubscription(); return sub ? devices.find((d) => sub.endpoint.endsWith(d.endpointTail)) ?? null : null; };

/** App-level wiring: keep the worker registered, follow a tap on a notification, keep this device's language in step with the app. */
export function useAlertsRuntime(locale: Locale, navigate: (path: string) => void): void {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void registerWorker();
    const onMsg = (e: MessageEvent) => { const d = e.data as { type?: string; url?: string } | null; if (d?.type === 'spw-nav' && typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//')) navigate(d.url); };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [navigate]);
  useEffect(() => {
    let off = false;
    void (async () => {
      const sub = await currentSubscription().catch(() => null);
      if (!sub || off) return;
      const mine = (await get<Device[]>('/push/subscriptions').catch(() => [] as Device[])).find((d) => sub.endpoint.endsWith(d.endpointTail));
      if (mine && mine.locale !== locale && !off) await api('PATCH', `/push/subscriptions/${mine.id}`, { locale }).catch(() => {});
    })();
    return () => { off = true; };
  }, [locale]);
}
