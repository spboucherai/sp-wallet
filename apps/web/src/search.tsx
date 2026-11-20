/**
 * NEXT — universal search (⌘K / Ctrl-K, and the search control of the header): assets, contacts, transactions (hash, address,
 * amount), destinations of the settings. The server's `GET /search` when this server has it, the local index otherwise — and
 * the local index always, so that typing answers at once. Fully keyboard-operable: the field is a combobox over a listbox,
 * ↑ ↓ Home End move, Enter opens, Escape closes (the shared Sheet: focus trapped, restored to what opened it).
 * A chunk of its own: fetched the first time the search is opened.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { get } from './api';
import { useNetworks, usePortfolio } from './hooks';
import { useT, type Key } from './i18n';
import { IN_APP } from './nav';
import { localSearch, mergeHits, moveSelection, type Destination } from './search-index';
import { itemTitle } from './tx-row';
import { AssetIcon, Icon, NetworkIcon, Sheet, trimAmt } from './ui';
import { useContacts } from './wallet';
import { serverSearch, type SearchHit } from './wallet-more';
import type { WalletItem } from './walletItems';

const DESTINATIONS: readonly (readonly [string, string, Key, string])[] = [
  ['settings', '/settings', 'settings', 'réglages langue devise apparence thème sombre clair language currency appearance theme dark light'],
  ['security', '/security', 'security', 'sécurité clés d’accès passkey sessions signataire signer limites limits récupération recovery'],
  ['contacts', '/contacts', 'nwContacts', 'carnet d’adresses address book'], ['alerts', '/alerts', 'alTitle', 'notifications alertes'],
  ['notifications', '/alerts?v=settings', 'nwSetNotifications', 'push notifications alertes webhook'], ['receive', '/receive', 'receive', 'adresse dépôt qr deposit address'], ['send', '/send', 'send', 'transfert envoyer transfer'],
  ['activity', '/activity', 'activity', 'historique history transactions csv export'], ['assets', '/assets', 'allAssets', 'jetons tokens favoris masqués favourites hidden'],
  ['risk', '/risk', 'rkTitle', 'risque limites kill switch'], ['developer', '/developer', 'dvTitle', 'api clés keys webhooks'], ['monitor', '/monitor', 'moTitle', 'état du système status réseaux networks'], ['swap', '/swap', 'swap', 'échanger convertir exchange'],
];
const ICON: Record<SearchHit['type'], string> = { asset: 'star', contact: 'users', transaction: 'list', setting: 'gear' };
const GROUP_KEY: Record<SearchHit['type'], Key> = { asset: 'nwSrAssets', contact: 'nwSrContacts', transaction: 'nwSrTx', setting: 'nwSrSettings' };

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const t = useT(); const id = useId();
  const pf = usePortfolio(), nets = useNetworks(), contacts = useContacts();
  // the movements the local index searches: the wallet's latest (one read, kept while the palette is used)
  const act = useQuery({ queryKey: ['activity', 'search'], queryFn: () => get<{ items: WalletItem[] }>('/activity?limit=200'), staleTime: 60_000 });
  const [q, setQ] = useState(''), [at, setAt] = useState(0), [server, setServer] = useState<{ q: string; hits: SearchHit[] | null } | null>(null);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  useEffect(() => { const h = setTimeout(() => input.current?.focus(), 30); return () => clearTimeout(h); }, []);
  const netName = (n: string) => nets.data?.find((x) => x.id === n)?.name ?? n;
  const local = useMemo(() => localSearch(q, { assets: pf.data?.balances ?? [], contacts: contacts.data ?? [], items: act.data?.items ?? [], netName, amount: (x) => trimAmt(x), txTitle: (i) => itemTitle(t, i as unknown as WalletItem, contacts.data),
    destinations: DESTINATIONS.map(([did, path, key, keywords]): Destination => ({ id: did, path, title: t(key), keywords })) }), [q, pf.data, contacts.data, act.data, nets.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the server's search, when this server has one: asked 200 ms after the last key; an older answer never replaces a newer question
  useEffect(() => { const s = q.trim(); if (s.length < 2) { setServer(null); return; } const ctl = new AbortController();
    const h = setTimeout(() => { void serverSearch(s, ctl.signal).then((hits) => { if (!ctl.signal.aborted) setServer({ q: s, hits }); }, () => { /* the local index answers */ }); }, 200);
    return () => { clearTimeout(h); ctl.abort(); }; }, [q]);
  const hits = useMemo(() => mergeHits(server && server.q === q.trim() ? server.hits : null, local), [server, local, q]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const open = (h: SearchHit) => { onClose(); history.pushState(IN_APP, '', h.path); dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); };
  // ↑ ↓ move through the results (wrapping), Enter opens the selected one; Home / End stay the text field's own keys
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { const h = hits[at]; if (h) { e.preventDefault(); open(h); } return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const k = moveSelection(e.key, at, hits.length); if (k !== null) { e.preventDefault(); setAt(k); }
  };
  const typed = q.trim().length >= 2;
  return <Sheet title={t('nwSrTitle')} onClose={onClose} wide testid="search">
    <div className="space-y-3">
      <div className="relative"><Icon n="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-mute" />
        <input ref={input} className="w-full rounded-[var(--radius-md)] border border-line bg-elev/60 py-3.5 pl-11 pr-4 outline-none focus:border-accent focus:bg-surface" type="text" role="combobox" aria-expanded={hits.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={hits[at] ? `${id}-${at}` : undefined} aria-label={t('nwSrPlaceholder')} placeholder={t('nwSrPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" enterKeyHint="search" data-testid="search-input" /></div>
      <p className="sr-only" role="status" aria-live="polite">{typed ? t(hits.length === 1 ? 'nwSrCount1' : 'nwSrCount', { n: hits.length }) : ''}</p>
      {!typed ? <p className="t-callout px-1 pb-2 text-mute" data-testid="search-hint">{t('nwSrHint')}</p>
        : hits.length === 0 ? <p className="t-callout px-1 pb-2 text-mute" data-testid="search-empty">{t('nwSrNone', { q: q.trim() })}</p>
        : <ul ref={list} id={`${id}-list`} role="listbox" aria-label={t('nwSrResults')} data-testid="search-results" data-server={server?.hits ? 'yes' : 'no'} className="-mx-1">{hits.map((h, k) => { const head = k === 0 || hits[k - 1]!.type !== h.type;
          return <li key={`${h.type}${h.id}${k}`} role="presentation">{head && <div className="t-eyebrow px-2.5 pb-1 pt-2" role="presentation">{t(GROUP_KEY[h.type])}</div>}
            <div id={`${id}-${k}`} role="option" aria-selected={k === at} data-type={h.type} data-path={h.path} className="palette-item cursor-pointer" onPointerMove={() => { if (at !== k) setAt(k); }} onClick={() => open(h)}>
              {h.type === 'asset' && h.symbol ? <AssetIcon sym={h.symbol} net={h.network} size={34} /> : h.type === 'contact' && h.network ? <NetworkIcon net={h.network} size={34} /> : <span className="disc !h-[34px] !w-[34px]" aria-hidden="true"><Icon n={ICON[h.type]} className="h-4 w-4" /></span>}
              <span className="min-w-0 flex-1"><span className="t-body-strong block truncate">{h.title}</span>{h.subtitle && <span className="t-footnote block truncate text-mute">{h.subtitle}</span>}</span>
              {k === at && <kbd className="kbd hidden sm:inline-block" aria-hidden="true">↵</kbd>}</div></li>; })}</ul>}
      <p className="t-micro hidden items-center gap-3 border-t border-line px-1 pt-3 text-mute sm:flex" aria-hidden="true"><span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> {t('nwSrKeysMove')}</span><span><kbd className="kbd">↵</kbd> {t('nwSrKeysOpen')}</span><span><kbd className="kbd">Esc</kbd> {t('nwSrKeysClose')}</span></p>
    </div></Sheet>;
}
