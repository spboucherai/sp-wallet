/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/screens/Contacts.tsx
 * Module           : screens
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT — Contacts: the address book as a screen of its own. List, add, edit (label, note, favourite), delete, and the one
// sensitive change — WHERE a contact points. Changing an address shows the old and the new value in full, asks for an explicit
// confirmation, and sends the address this screen was showing (`currentAddress`): the server refuses a stale screen
// (`stale_contact`) and an address another contact already has (`duplicate_contact`), and records a security event.
// A contact is a label for the owner's eyes: the destination a transfer approves is always the full address on its review.
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError } from '../api';
import type { Nav } from '../App';
import { useNetworks } from '../hooks';
import { errText, useT } from '../i18n';
import { Addr, Btn, Card, CopyBtn, EmptyState, ErrorState, Fact, Field, Icon, inputCls, NetworkIcon, Notice, PageTitle, Sheet, SkeletonRows, Toggle } from '../ui';
import { contactsApi, useContacts, type Contact } from '../wallet';
import { shortAddr } from '../walletItems';

/** does a contact match the search? label, note, address (whole or part), network */
export const matchesContact = (c: Pick<Contact, 'label' | 'note' | 'address' | 'network'>, q: string, netName = ''): boolean => {
  const s = q.trim().toLowerCase(); if (!s) return true;
  return c.label.toLowerCase().includes(s) || (c.note ?? '').toLowerCase().includes(s) || c.address.toLowerCase().includes(s) || c.network.includes(s) || netName.toLowerCase().includes(s);
};
/** what a contact error says: the two guards of an address change have their own sentence, everything else the usual error text */
function contactError(t: ReturnType<typeof useT>, e: unknown): string {
  const code = e instanceof ApiError ? e.code : '';
  return code === 'stale_contact' ? t('nwCtStale') : code === 'duplicate_contact' ? t('nwCtDuplicate') : errText(t, e) || t('nwCtFailed');
}

export function Contacts({ nav }: { nav: Nav }) {
  const t = useT(); const qc = useQueryClient();
  const q = useContacts(), nets = useNetworks();
  const [search, setSearch] = useState(''), [edit, setEdit] = useState<Contact | null>(null), [adding, setAdding] = useState(false), [err, setErr] = useState('');
  const netName = (id: string) => nets.data?.find((n) => n.id === id)?.name ?? id;
  const rows = useMemo(() => (q.data ?? []).filter((c) => matchesContact(c, search, netName(c.network))).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.label.localeCompare(b.label)), [q.data, search, nets.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['contacts'] }); void qc.invalidateQueries({ queryKey: ['book'] }); };
  const star = (c: Contact) => {   // optimistic, with rollback
    setErr(''); const prev = qc.getQueryData<Contact[]>(['contacts']);
    qc.setQueryData<Contact[]>(['contacts'], (l) => (l ?? []).map((x) => (x.id === c.id ? { ...x, favorite: !c.favorite } : x)));
    void contactsApi.edit(c.id, { favorite: !c.favorite }).then(refresh, (e) => { qc.setQueryData(['contacts'], prev); setErr(contactError(t, e)); });
  };
  if (!q.data && q.isError) return <div className="space-y-4" data-testid="contacts-error"><PageTitle>{t('nwContacts')}</PageTitle><ErrorState title={t('nxErrLoad')} offline={(q.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void q.refetch()}>{t('nxErrLoadBody')}</ErrorState></div>;
  return (
    <div className="space-y-4" data-testid="contacts">
      <PageTitle right={<Btn className="!min-h-11 shrink-0" onClick={() => { setErr(''); setAdding(true); }} data-testid="contact-add"><Icon n="plus" className="h-4 w-4" />{t('nwCtAdd')}</Btn>}>{t('nwContacts')}</PageTitle>
      {err && <Notice tone="danger" testid="contacts-err">{err}</Notice>}
      <div className="panes panes-side space-y-4 lg:space-y-0">
        <div className="pane-sticky min-w-0 space-y-3">
          <div className="relative"><Icon n="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-mute" />
            <input className={`${inputCls} !pl-11`} type="search" placeholder={t('nwCtSearch')} aria-label={t('nwCtSearch')} value={search} onChange={(e) => setSearch(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>
          <p className="t-footnote reading text-mute">{t('nwCtNote')}</p>
        </div>
        <div className="min-w-0">
          {!q.data ? <SkeletonRows n={4} /> : rows.length === 0 ? (q.data.length === 0
            ? <EmptyState icon="users" title={t('nwCtEmpty')} action={<Btn kind="soft" onClick={() => setAdding(true)}>{t('nwCtAdd')}</Btn>}>{t('nwCtEmptyBody')}</EmptyState>
            : <EmptyState icon="search" title={t('nwCtNoMatch')} />)
            : <Card className="!px-0 !py-1"><ul data-testid="contact-list">{rows.map((c) => <li key={c.id} className="flex items-stretch" data-testid="contact-row" data-id={c.id}>
              <button className="row row-press min-w-0 flex-1" onClick={() => { setErr(''); setEdit(c); }}>
                <NetworkIcon net={c.network} size={40} />
                <span className="min-w-0 flex-1"><span className="t-body-strong block truncate leading-tight">{c.label}</span>
                  <span className="t-footnote mt-0.5 block truncate text-mute">{netName(c.network)} · <span className="font-mono">{shortAddr(c.address)}</span></span>
                  {c.note && <span className="t-footnote mt-0.5 block truncate text-mute">{c.note}</span>}</span>
                <Icon n="chev" className="h-4 w-4 shrink-0 text-mute" /></button>
              <span className="flex shrink-0 items-center pr-2"><button type="button" aria-pressed={c.favorite} aria-label={t(c.favorite ? 'nwUnfav' : 'nwFav', { name: c.label })} data-testid="contact-fav" onClick={() => star(c)} className={`press grid h-11 w-11 place-items-center rounded-full ${c.favorite ? 'text-caution' : 'text-mute'}`}><Icon n={c.favorite ? 'starFill' : 'star'} className="h-5 w-5" /></button></span>
            </li>)}</ul></Card>}
        </div>
      </div>
      {adding && <AddSheet networks={(nets.data ?? []).map((n) => ({ id: n.id, name: n.name }))} onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
      {edit && <EditSheet c={edit} netName={netName(edit.network)} onClose={() => setEdit(null)} onDone={() => { setEdit(null); refresh(); }} onReload={() => { refresh(); setEdit(null); }} onSend={() => nav({ tab: 'send', network: edit.network, view: edit.address })} />}
    </div>
  );
}

function AddSheet({ networks, onClose, onDone }: { networks: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [network, setNetwork] = useState(networks.find((n) => n.id === 'base')?.id ?? networks[0]?.id ?? ''), [address, setAddress] = useState(''), [label, setLabel] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try { const c = await contactsApi.add({ network, address: address.trim(), label: label.trim() }); if (note.trim()) await contactsApi.edit(c.id, { note: note.trim() }).catch(() => { /* the contact exists; the note can be added again */ }); onDone(); }
    catch (e) { setErr(contactError(t, e)); } finally { setBusy(false); }
  };
  return <Sheet title={t('nwCtAddTitle')} onClose={onClose} busy={busy} testid="contact-add-sheet"
    footer={<Btn full busy={busy} disabled={!network || !address.trim() || !label.trim()} onClick={() => void save()} data-testid="contact-save">{t('save')}</Btn>}>
    <div className="space-y-4">
      <Field label={t('network')}><select className={inputCls} value={network} onChange={(e) => setNetwork(e.target.value)} data-testid="contact-network">{networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
      <Field label={t('nwCtAddress')} hint={t('nwCtAddressHint')}><textarea className={`${inputCls} t-mono min-h-[5.25rem] resize-none break-all`} value={address} onChange={(e) => setAddress(e.target.value.replace(/\s/g, ''))} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" data-testid="contact-address" /></Field>
      <Field label={t('label')}><input className={inputCls} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} data-testid="contact-label" /></Field>
      <Field label={t('nwCtNoteField')}><input className={inputCls} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} data-testid="contact-note" /></Field>
      {err && <Notice tone="danger" testid="contact-err">{err}</Notice>}
    </div></Sheet>;
}

function EditSheet({ c, netName, onClose, onDone, onReload, onSend }: { c: Contact; netName: string; onClose: () => void; onDone: () => void; onReload: () => void; onSend: () => void }) {
  const t = useT();
  const [label, setLabel] = useState(c.label), [note, setNote] = useState(c.note ?? ''), [favorite, setFavorite] = useState(c.favorite);
  const [moving, setMoving] = useState(false), [address, setAddress] = useState(''), [checked, setChecked] = useState(false), [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [stale, setStale] = useState(false);
  const next = address.trim(), changing = moving && next !== '' && next !== c.address;
  const dirty = label.trim() !== c.label || note !== (c.note ?? '') || favorite !== c.favorite || changing;
  const save = async () => {
    setBusy('save'); setErr('');
    try { await contactsApi.edit(c.id, { ...(label.trim() !== c.label ? { label: label.trim() } : {}), ...(note !== (c.note ?? '') ? { note } : {}), ...(favorite !== c.favorite ? { favorite } : {}), ...(changing ? { address: next, currentAddress: c.address } : {}) }); onDone(); }
    catch (e) { setErr(contactError(t, e)); if (e instanceof ApiError && e.code === 'stale_contact') setStale(true); } finally { setBusy(''); }
  };
  const remove = async () => { setBusy('del'); setErr(''); try { await contactsApi.remove(c.id); onDone(); } catch (e) { setErr(contactError(t, e)); } finally { setBusy(''); } };
  return <Sheet title={t('nwCtEditTitle')} sub={netName} onClose={onClose} busy={!!busy} testid="contact-edit-sheet"
    footer={stale ? <Btn full kind="soft" onClick={onReload} data-testid="contact-reload"><Icon n="refresh" className="h-4 w-4" />{t('nwCtReload')}</Btn>
      : <Btn full busy={busy === 'save'} disabled={!dirty || !label.trim() || (changing && !checked) || !!busy} onClick={() => void save()} data-testid="contact-save">{changing ? t('nwCtSaveMove') : t('save')}</Btn>}>
    <div className="space-y-4">
      <Field label={t('label')}><input className={inputCls} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} data-testid="contact-label" /></Field>
      <Field label={t('nwCtNoteField')}><input className={inputCls} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} data-testid="contact-note" /></Field>
      <div className="flex items-center justify-between gap-4"><span className="t-body">{t('nwCtFavorite')}</span><Toggle label={t('nwCtFavorite')} on={favorite} onChange={setFavorite} testid="contact-fav-toggle" /></div>
      <dl><Fact stack k={t('nwCtAddressNow')} testid="contact-current"><Addr value={c.address} /><div className="mt-2 flex flex-wrap gap-2"><CopyBtn small text={c.address} /><Btn kind="soft" className="!min-h-11 !text-[0.84375rem]" onClick={onSend} data-testid="contact-send"><Icon n="arrowUp" className="h-4 w-4" />{t('send')}</Btn></div></Fact></dl>
      {!moving ? <button type="button" className="link" onClick={() => setMoving(true)} data-testid="contact-move">{t('nwCtMove')}</button> : <div className="space-y-3" data-testid="contact-move-box">
        <Field label={t('nwCtAddressNew')}><textarea className={`${inputCls} t-mono min-h-[5.25rem] resize-none break-all`} value={address} onChange={(e) => { setAddress(e.target.value.replace(/\s/g, '')); setChecked(false); }} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" data-testid="contact-new-address" /></Field>
        {changing && <>
          {/* the confirmation: both values in FULL, the old one above the new one — nothing shortened */}
          <Notice tone="warn"><b className="block font-semibold">{t('nwCtMoveTitle', { label: c.label })}</b>{t('nwCtMoveBody')}</Notice>
          <dl className="rounded-[var(--radius-md)] border border-line px-4" data-testid="contact-move-review"><Fact stack k={t('nwCtOld')}><span className="t-mono break-all" data-testid="contact-old">{c.address}</span></Fact><Fact stack k={t('nwCtNew')}><span className="t-mono break-all" data-testid="contact-new">{next}</span></Fact></dl>
          <label className="ack-row"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="contact-move-check" />{t('nwCtMoveCheck')}</label></>}
      </div>}
      {err && <Notice tone="danger" testid="contact-err">{err}</Notice>}
      <div className="border-t border-line pt-3">{confirmDel
        ? <div className="grid grid-cols-2 gap-3"><Btn kind="ghost" disabled={!!busy} onClick={() => setConfirmDel(false)}>{t('cancel')}</Btn><Btn kind="danger" busy={busy === 'del'} onClick={() => void remove()} data-testid="contact-delete-confirm">{t('nwCtDeleteConfirm')}</Btn></div>
        : <Btn kind="quiet" className="!text-negative !px-0" disabled={!!busy} onClick={() => setConfirmDel(true)} data-testid="contact-delete"><Icon n="trash" className="h-4 w-4" />{t('nwCtDelete')}</Btn>}</div>
    </div></Sheet>;
}
