import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { useAccounts, useNetworks } from '../hooks';
import { useT } from '../i18n';
import { paymentUri } from '../payment-uri';
import { Addr, Btn, Card, Chips, CopyBtn, EmptyState, ErrorState, H, haptic, Icon, NetworkIcon, Notice, PageTitle, Skeleton, trimAmt } from '../ui';

export function Receive({ initial, nav }: { initial?: string; nav?: Nav }) {
  const t = useT(); const acc = useAccounts(), nets = useNetworks();
  const [net, setNet] = useState(initial ?? 'base'); const [qr, setQr] = useState<{ for: string; url: string | null } | null>(null);   // url null: the code could not be generated
  const a = acc.data?.accounts.find((x) => x.network === net), n = nets.data?.find((x) => x.id === net);
  // Error correction Q (25 % of the code can be lost): the network's logo sits on a plate over ~4 % of the surface. Q, not H:
  // H makes the code denser for no need, and a denser code is the harder one to scan from a distance.
  // Scan reliability of this exact rendering is tested for every network (tests/e2e/v9-qr-scan.py, OpenCV decoder).
  useEffect(() => { if (a) void QRCode.toDataURL(a.address, { margin: 1, width: 720, errorCorrectionLevel: 'Q', color: { dark: '#080B12', light: '#FFFFFF' } }).then((url) => setQr({ for: a.address, url }), () => setQr({ for: a.address, url: null })); }, [a?.address]);   // NEXT W5: a failure is said, the address stays
  // NEXT W3: a failed load is an error state with a retry; a network that does not exist (a mistyped or old link) is said as such
  const failed = (!acc.data && acc.isError) || (!nets.data && nets.isError);
  if (failed) return <div className="space-y-4" data-testid="receive-error"><PageTitle>{t('receiveTitle')}</PageTitle><ErrorState title={t('nxErrLoad')} offline={((acc.error ?? nets.error) as { code?: string } | null)?.code === 'offline'} onRetry={() => { void acc.refetch(); void nets.refetch(); }}>{t('nxErrLoadBody')}</ErrorState></div>;
  if (acc.data && nets.data && (!a || !n)) return <div className="space-y-4" data-testid="receive-not-found"><PageTitle>{t('receiveTitle')}</PageTitle>
    <EmptyState icon="search" title={t('nxNetNotFoundTitle')}>{t('nxNetNotFoundBody', { net })}</EmptyState>
    <Card><H>{t('nxChooseNetwork')}</H><Chips label={t('network')} value={net} onChange={(v) => { setNet(v); nav?.({ tab: 'receive', network: v }); }} options={nets.data.filter((x) => acc.data!.accounts.some((y) => y.network === x.id)).map((x) => ({ id: x.id, label: x.name, net: x.id }))} /></Card></div>;
  if (!a || !n) return <div className="space-y-4" aria-busy="true"><Skeleton h="h-11" className="!w-40 !rounded-xl" /><Skeleton h="h-[520px]" /></div>;
  const assets = [n.native.symbol, ...n.tokens.map((x) => x.symbol)];
  const canShare = typeof navigator.share === 'function';
  const pay = paymentUri(n, a.address);
  const ready = qr?.for === a.address && qr.url !== null, qrFailed = qr?.for === a.address && qr.url === null;
  return (
    <div className="page space-y-4" data-testid="receive">
      <PageTitle>{t('receiveTitle')}</PageTitle>
      <Card>
        <Chips label={t('network')} value={net} onChange={setNet} options={nets.data!.map((x) => ({ id: x.id, label: x.name, net: x.id }))} />
        <div className="mt-5 grid place-items-center">
          {/* the QR code sits on a WHITE plate in both themes (design system: the QR plate is always white) — a scanner needs the contrast */}
          <div className="relative w-full max-w-[16.5rem] rounded-[var(--radius-xl)] bg-white p-3.5 shadow-e2 ring-1 ring-line" data-testid="qr-card">
            {ready ? <img src={qr!.url!} alt={`QR ${a.address}`} width={720} height={720} className="block h-auto w-full rounded-xl" /> : qrFailed ? <div className="t-footnote grid aspect-square w-full place-items-center rounded-xl p-4 text-center" style={{ background: '#f1f3f7', color: '#3b4252' }} role="alert" data-testid="qr-failed">{t('nxQrFailed')}</div> : <div className="skel aspect-square w-full !rounded-xl" />}
            {ready && <span className="pointer-events-none absolute left-1/2 top-1/2 grid h-[21%] w-[21%] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white p-[3px]" aria-hidden="true" data-testid="qr-logo"><NetworkIcon net={n.id} size={44} className="!h-full !w-full" /></span>}
          </div>
        </div>
        <div className="t-body-strong mt-4 flex items-center justify-center gap-2"><NetworkIcon net={n.id} size={22} />{n.name}</div>
        <p className="t-footnote mt-1 text-center text-mute">{assets.slice(0, 6).join(' · ')}{assets.length > 6 ? ` · +${assets.length - 6}` : ''}</p>
        <div className="mt-4 rounded-[var(--radius-md)] bg-elev/70 p-4 text-center"><div className="t-footnote mb-1 text-mute">{t('yourAddress')} · {n.name}</div><Addr value={a.address} /></div>
        <div className={`mt-3 grid gap-3 ${canShare ? 'grid-cols-[1fr_auto_auto]' : 'grid-cols-2'}`}><CopyBtn text={a.address} full />
          {canShare && <Btn kind="soft" aria-label={t('nwRcShare')} data-testid="recv-share" onClick={() => { haptic(); void navigator.share({ text: a.address }).catch(() => {}); }}><Icon n="share" className="h-[18px] w-[18px]" /></Btn>}
          <a href={a.explorer} target="_blank" rel="noreferrer noopener" className="btn press inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-md)] border border-line px-5 text-[0.96875rem] font-medium"><Icon n="ext" className="h-4 w-4" />{t('explorer')}</a></div>
        {/* NEXT: a payment link where the network has a standard one (payment-uri.ts) — the address and the network, never an amount */}
        {pay && <div className="mt-3 border-t border-line pt-3" data-testid="recv-uri" data-uri={pay.uri}>
          <div className="flex flex-wrap gap-2"><CopyBtn small text={pay.uri} label={t('nwRcUri')} />
            {canShare && <Btn kind="soft" className="!min-h-11 !text-[0.84375rem]" data-testid="recv-share-uri" onClick={() => { haptic(); void navigator.share({ text: pay.uri }).catch(() => {}); }}><Icon n="share" className="h-4 w-4" />{t('dsShare')}</Btn>}</div>
          <p className="t-footnote mt-2 text-mute">{t('nwRcUriNote', { std: pay.standard })}</p><p className="t-mono mt-1 break-all text-mute">{pay.uri}</p></div>}
      </Card>
      {acc.data?.signerReachable === false && <Notice tone="warn"><span data-testid="addr-cached">{t('svAddrFromCache', { date: acc.data.addressesAsOf ? new Date(acc.data.addressesAsOf).toLocaleString() : '—' })}</span></Notice>}
      <Notice tone="warn">{t('onlySend', { assets: assets.length > 4 ? `${assets.slice(0, 3).join(' / ')}… (${assets.length})` : assets.join(' / '), network: n.name })}</Notice>
      {n.family === 'evm' && <Notice tone="info">{t('evmSame')}</Notice>}
      {/* NFT audit (docs/nft/NFT-AUDIT.md §4): BTC sends are not inscription-aware */}
      {n.id === 'bitcoin' && <Notice tone="warn"><span data-testid="recv-ordinals-warning">{t('nfRecvWarn_ordinals_not_protected')}</span></Notice>}
      {n.activation && n.family !== 'cardano' && n.family !== 'polkadot' && <Notice tone="info">{t('activationNote', { network: n.name, amount: trimAmt(n.activation, 12), sym: n.native.symbol })}</Notice>}
      {/* v8-cardano-polkadot ↓ chain-specific receive warnings */}
      {n.family === 'cardano' && <><Notice tone="info">{t('cdRecvMin')}</Notice><Notice tone="warn">{t('cdRecvTokens')}</Notice><Notice tone="info">{t('cdRecvRecover')}</Notice></>}
      {n.family === 'polkadot' && <><Notice tone="warn">{t('dtRecvHub')}</Notice><Notice tone="info">{t('dtRecvEd', { amount: trimAmt(n.activation ?? '0.01', 12) })}</Notice><Notice tone="warn">{t('dtRecvKey')}</Notice></>}
      {/* v8-cardano-polkadot ↑ */}
      <Card><H>{t('addressFromSigner')}</H><ul className="space-y-2 text-[0.84375rem] text-mute">
        <li>{n.minConf === 1 ? t('qaDepositShown1') : t('depositShown', { n: n.minConf })}</li>
        {n.tokens.length > 0 && <li>{t('gasNote', { sym: n.native.symbol })}</li>}
      </ul></Card>
    </div>
  );
}
