/**
 * V11 interface — the parts of the shell that are NOT needed to draw the first screen, in a chunk of their own so that the
 * first chunk weighs what it weighed before the pass (App.tsx asks for this chunk as soon as the shell mounts; it arrives
 * while the first screen is drawing):
 *   RiskIndicator   always on screen once loaded — kill switch / read-only mode / live limits, icon + word; a tap opens Risk;
 *   Sidebar         the desktop navigation (a phone never shows it);
 *   ShellMenu       the phone's header menu: what the five areas do not hold.
 * docs/v11/UI-ARCHITECTURE.md.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { get } from './api';
import type { Tab } from './App';
import { AREAS, type Area } from './nav';
import { useT, type Key } from './i18n';
import { Icon, Sheet } from './ui';

/** what the indicator reads: the two global switches of the risk engine and the owner's live limits (GET /dashboard/status) */
export interface RiskStatus { switches: { ok: true; data: { killSwitch: { on: boolean }; readOnly: { on: boolean } } } | { ok: false }; liveLimits: { ok: true; data: { missing: number; ownerOrdersRefused: boolean } } | { ok: false } }
export type RiskLevel = 'kill' | 'readonly' | 'limits' | 'ok' | 'unknown';
/** the worst thing first: kill switch, then read-only mode, then live limits not set; `unknown` when the switches cannot be read (never « ok » by default) */
export const riskLevel = (s: RiskStatus | undefined): RiskLevel => (!s || !s.switches.ok ? 'unknown' : s.switches.data.killSwitch.on ? 'kill' : s.switches.data.readOnly.on ? 'readonly' : s.liveLimits.ok && s.liveLimits.data.ownerOrdersRefused ? 'limits' : 'ok');
const RISK_LOOK: Record<RiskLevel, { icon: string; cls: string }> = {
  kill: { icon: 'stop', cls: 'bg-danger text-[var(--ondanger)]' }, readonly: { icon: 'lock', cls: 'bg-warn/12 text-warn' }, limits: { icon: 'warn', cls: 'bg-elev text-ink' },
  ok: { icon: 'check', cls: 'bg-elev text-mute' }, unknown: { icon: 'clock', cls: 'bg-elev text-mute' } };
/** `row`: the sidebar's entry (label on the left, state on the right); otherwise the header's pill */
export function RiskIndicator({ go, current, row }: { go: (t: Tab) => void; current: boolean; row?: boolean }) {
  const t = useT();
  const q = useQuery({ queryKey: ['risk', 'status'], queryFn: () => get<RiskStatus>('/dashboard/status'), refetchInterval: 20_000, staleTime: 10_000, retry: 0 });
  const level = riskLevel(q.data), look = RISK_LOOK[level], word = t(`v11NavRisk_${level}` as Key), label = t('v11NavRiskAria', { state: t(`v11NavRiskLong_${level}` as Key) });
  if (row) return <button onClick={() => go('risk')} data-testid="risk-indicator" data-level={level} aria-label={label} aria-current={current ? 'page' : undefined} className={sideCls(current, true)}>
    <Icon n="shield" /><span className="flex-1 text-left">{t('rkTitle')}</span><span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.71875rem] font-semibold ${look.cls}`}><Icon n={look.icon} className="h-3 w-3" />{word}</span></button>;
  return <button onClick={() => go('risk')} data-testid="risk-indicator" data-level={level} aria-label={label} title={label} aria-current={current ? 'page' : undefined} className="press grid h-11 shrink-0 place-items-center px-0.5">
    <span className={`inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[0.75rem] font-semibold ${look.cls}`}><Icon n={look.icon} className="h-3.5 w-3.5" />{word}</span></button>;
}

export const sideCls = (on: boolean, small = false): string => `press flex w-full items-center gap-3 rounded-2xl px-3.5 ${small ? 'py-2.5' : 'py-3'} text-[0.9375rem] font-medium ${on ? 'bg-primary text-onprimary shadow-e1' : 'text-mute hover:bg-elev hover:text-ink'}`;
// what the five areas do not hold: the header menu on a phone, the bottom of the sidebar on a desktop
const MORE: readonly (readonly [Tab, string, Key])[] = [['settings', 'gear', 'settings'], ['security', 'shield', 'security'], ['contacts', 'users', 'nwContacts'], ['developer', 'key', 'dvTitle'], ['monitor', 'bars', 'moTitle']];

export function Sidebar({ tab, area, go, toArea, lock, bell }: { tab: Tab; area: Area | null; go: (t: Tab) => void; toArea: (a: Area) => void; lock: () => void; /** the alerts entry, drawn by the shell (it owns the unread count) */ bell: ReactNode }) {
  const t = useT();
  const side = (id: Tab, icon: string, label: Key) => <button key={id} onClick={() => go(id)} data-menu={id} aria-current={tab === id ? 'page' : undefined} className={sideCls(tab === id, true)}><Icon n={icon} />{t(label)}</button>;
  return <>
    <nav className="space-y-1.5" aria-label={t('v11NavMain')} data-testid="nav-areas">{AREAS.map(([id, icon, label]) =>
      <button key={id} onClick={() => toArea(id)} data-area={id} aria-current={area === id ? 'page' : undefined} className={sideCls(area === id)}><Icon n={icon} />{t(label)}</button>)}</nav>
    <div className="mt-5 space-y-1 border-t border-line pt-4">{side('receive', 'down', 'receive')}{side('send', 'up', 'send')}</div>
    <nav className="mt-auto space-y-1 pt-6" aria-label={t('v11NavMore')}>
      <RiskIndicator go={go} current={tab === 'risk'} row />
      {bell}
      {MORE.map(([id, icon, label]) => side(id, icon, label))}
      <button onClick={lock} data-menu="lock" className={sideCls(false, true)}><Icon n="lock" />{t('logout')}</button>
    </nav>
  </>;
}

export function ShellMenu({ tab, go, lock, onClose }: { tab: Tab; go: (t: Tab) => void; lock: () => void; onClose: () => void }) {
  const t = useT();
  const row = 'row-press flex min-h-[56px] w-full items-center gap-3.5 px-1 py-2 text-left', disc = 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-elev';
  return <Sheet title={t('v11NavMenu')} onClose={onClose} testid="nav-menu-sheet">
    <nav aria-label={t('v11NavMore')} className="-mx-1 divide-y divide-line">{([['receive', 'down', 'receive'], ['send', 'up', 'send'], ['risk', 'shield', 'rkTitle'], ['alerts', 'bell', 'alTitle'], ...MORE, ['research', 'search', 'rjTitle']] as readonly (readonly [Tab, string, Key])[]).map(([id, icon, label]) =>
      <button key={id} onClick={() => { onClose(); go(id); }} data-menu={id} aria-current={tab === id ? 'page' : undefined} className={row}>
        <span className={disc}><Icon n={icon} className="h-[19px] w-[19px]" /></span><span className="flex-1 text-[0.96875rem] font-semibold">{t(label)}</span><Icon n="chev" className="h-5 w-5 text-mute" /></button>)}
      <button onClick={() => { onClose(); lock(); }} data-menu="lock" className={row}><span className={disc}><Icon n="lock" className="h-[19px] w-[19px]" /></span><span className="flex-1 text-[0.96875rem] font-semibold">{t('logout')}</span></button>
    </nav></Sheet>;
}
