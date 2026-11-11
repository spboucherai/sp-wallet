import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useAccounts, useNetworks } from '../hooks';
import { useT } from '../i18n';
import { Addr, Card, Chips, CopyBtn, H, Icon, Notice, Skeleton } from '../ui';

export function Receive({ initial }: { initial?: string }) {
  const t = useT(); const acc = useAccounts(), nets = useNetworks();
  const [net, setNet] = useState(initial ?? 'base'); const [qr, setQr] = useState('');
  const a = acc.data?.accounts.find((x) => x.network === net), n = nets.data?.find((x) => x.id === net);
  useEffect(() => { if (a) void QRCode.toDataURL(a.address, { margin: 1, width: 560, errorCorrectionLevel: 'M', color: { dark: '#080B12', light: '#FFFFFF' } }).then(setQr); }, [a?.address]);
  if (!a || !n) return <div className="space-y-4"><Skeleton h="h-80" /></div>;
  const assets = [n.native.symbol, ...n.tokens.map((x) => x.symbol)];
  return (
    <div className="space-y-4">
      <h1 className="pt-2 text-[30px] font-semibold tracking-[-0.02em]">{t('receiveTitle')}</h1>
      <Card>
        <Chips label={t('network')} value={net} onChange={setNet} options={nets.data!.map((x) => ({ id: x.id, label: x.name, net: x.id }))} />
        <p className="mt-3 text-center text-[13px] text-mute">{assets.slice(0, 6).join(' · ')}{assets.length > 6 ? ` · +${assets.length - 6}` : ''}</p>
        <div className="mt-4 grid place-items-center">{qr ? <img src={qr} alt={`QR ${a.address}`} className="h-auto w-full max-w-[240px] rounded-3xl border border-line bg-white p-3" /> : <div className="h-[280px] w-[280px] animate-pulse rounded-2xl bg-elev" />}</div>
        <div className="mt-5 rounded-2xl bg-elev/70 p-4 text-center"><div className="mb-1 text-xs text-mute">{t('yourAddress')} · {n.name}</div><Addr value={a.address} /></div>
        <div className="mt-3 grid grid-cols-2 gap-3"><CopyBtn text={a.address} full />
          <a href={a.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl border border-line px-4 text-[15.5px]"><Icon n="ext" className="h-4 w-4" />{t('explorer')}</a></div>
      </Card>
      <Notice tone="warn">{t('onlySend', { assets: assets.length > 4 ? `${assets.slice(0, 3).join(' / ')}… (${assets.length})` : assets.join(' / '), network: n.name })}</Notice>
      {n.family === 'evm' && <Notice tone="info">{t('evmSame')}</Notice>}
      {n.activation && <Notice tone="info">{t('activationNote', { network: n.name, amount: n.activation, sym: n.native.symbol })}</Notice>}
      <Card><H>{t('addressFromSigner')}</H><ul className="space-y-2 text-[13.5px] text-mute">
        <li>{n.minConf === 1 ? t('qaDepositShown1') : t('depositShown', { n: n.minConf })}</li>
        {n.tokens.length > 0 && <li>{t('gasNote', { sym: n.native.symbol })}</li>}
      </ul></Card>
    </div>
  );
}
