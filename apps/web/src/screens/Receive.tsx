import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useAccounts, useNetworks } from '../hooks';
import { useT } from '../i18n';
import { Addr, Btn, Card, Chips, CopyBtn, H, haptic, Icon, NetworkIcon, Notice, PageTitle, Skeleton, trimAmt } from '../ui';

export function Receive({ initial }: { initial?: string }) {
  const t = useT(); const acc = useAccounts(), nets = useNetworks();
  const [net, setNet] = useState(initial ?? 'base'); const [qr, setQr] = useState<{ for: string; url: string } | null>(null);
  const a = acc.data?.accounts.find((x) => x.network === net), n = nets.data?.find((x) => x.id === net);
  // Error correction Q (25 % of the code can be lost): the network's logo sits on a plate over ~4 % of the surface. Q, not H:
  // H makes the code denser for no need, and a denser code is the harder one to scan from a distance.
  // Scan reliability of this exact rendering is tested for every network (tests/e2e/v9-qr-scan.py, OpenCV decoder).
  useEffect(() => { if (a) void QRCode.toDataURL(a.address, { margin: 1, width: 720, errorCorrectionLevel: 'Q', color: { dark: '#080B12', light: '#FFFFFF' } }).then((url) => setQr({ for: a.address, url })); }, [a?.address]);
  if (!a || !n) return <div className="space-y-4" aria-busy="true"><Skeleton h="h-11" className="!w-40 !rounded-xl" /><Skeleton h="h-[520px]" /></div>;
  const assets = [n.native.symbol, ...n.tokens.map((x) => x.symbol)];
  const canShare = typeof navigator.share === 'function';
  const ready = qr?.for === a.address;
  return (
    <div className="space-y-4">
      <PageTitle>{t('receiveTitle')}</PageTitle>
      <Card>
        <Chips label={t('network')} value={net} onChange={setNet} options={nets.data!.map((x) => ({ id: x.id, label: x.name, net: x.id }))} />
        <div className="mt-5 grid place-items-center">
          <div className="relative w-full max-w-[264px] rounded-[28px] bg-white p-3.5 shadow-e2 ring-1 ring-line" data-testid="qr-card">
            {ready ? <img src={qr!.url} alt={`QR ${a.address}`} width={720} height={720} className="block h-auto w-full rounded-xl" /> : <div className="skel aspect-square w-full !rounded-xl" />}
            {ready && <span className="pointer-events-none absolute left-1/2 top-1/2 grid h-[21%] w-[21%] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white p-[3px]" aria-hidden="true" data-testid="qr-logo"><NetworkIcon net={n.id} size={44} className="!h-full !w-full" /></span>}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-center gap-2 text-[15px] font-semibold"><NetworkIcon net={n.id} size={22} />{n.name}</div>
        <p className="mt-1 text-center text-[13px] text-mute">{assets.slice(0, 6).join(' · ')}{assets.length > 6 ? ` · +${assets.length - 6}` : ''}</p>
        <div className="mt-4 rounded-2xl bg-elev/70 p-4 text-center"><div className="mb-1 text-xs text-mute">{t('yourAddress')} · {n.name}</div><Addr value={a.address} /></div>
        <div className={`mt-3 grid gap-3 ${canShare ? 'grid-cols-[1fr_auto_auto]' : 'grid-cols-2'}`}><CopyBtn text={a.address} full />
          {canShare && <Btn kind="soft" aria-label={t('dsShare')} onClick={() => { haptic(); void navigator.share({ text: a.address }).catch(() => {}); }}><Icon n="share" className="h-[18px] w-[18px]" /></Btn>}
          <a href={a.explorer} target="_blank" rel="noreferrer noopener" className="press inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl border border-line px-4 text-[15.5px] font-medium"><Icon n="ext" className="h-4 w-4" />{t('explorer')}</a></div>
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
      <Card><H>{t('addressFromSigner')}</H><ul className="space-y-2 text-[13.5px] text-mute">
        <li>{n.minConf === 1 ? t('qaDepositShown1') : t('depositShown', { n: n.minConf })}</li>
        {n.tokens.length > 0 && <li>{t('gasNote', { sym: n.native.symbol })}</li>}
      </ul></Card>
    </div>
  );
}
