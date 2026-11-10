import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useAccounts, useNetworks } from '../hooks';
import { useT } from '../i18n';
import { Addr, Card, CopyBtn, H, Icon, inputCls, Notice, Skeleton } from '../ui';

export function Receive() {
  const t = useT(); const acc = useAccounts(), nets = useNetworks();
  const [net, setNet] = useState('base'); const [qr, setQr] = useState('');
  const a = acc.data?.accounts.find((x) => x.network === net), n = nets.data?.find((x) => x.id === net);
  useEffect(() => { if (a) void QRCode.toDataURL(a.address, { margin: 1, width: 560, errorCorrectionLevel: 'M', color: { dark: '#080B12', light: '#FFFFFF' } }).then(setQr); }, [a?.address]);
  if (!a || !n) return <div className="space-y-4"><Skeleton h="h-80" /></div>;
  const assets = [n.native.symbol, ...n.tokens.map((x) => x.symbol)];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('receiveTitle')}</h1>
      <Card>
        <label className="block"><span className="mb-1.5 block text-[13px] text-mute">{t('network')}</span>
          <select className={inputCls} value={net} onChange={(e) => setNet(e.target.value)}>{nets.data!.map((x) => <option key={x.id} value={x.id}>{x.name} — {[x.native.symbol, ...x.tokens.map((k) => k.symbol)].join(', ')}</option>)}</select></label>
        <div className="mt-4 grid place-items-center">{qr ? <img src={qr} alt={`QR ${a.address}`} className="h-auto w-full max-w-[280px] rounded-2xl bg-white p-2" /> : <div className="h-[280px] w-[280px] animate-pulse rounded-2xl bg-elev" />}</div>
        <div className="mt-4 rounded-xl bg-bg p-3 text-center"><div className="mb-1 text-xs text-mute">{t('yourAddress')} · {n.name}</div><Addr value={a.address} /></div>
        <div className="mt-3 grid grid-cols-2 gap-3"><CopyBtn text={a.address} full />
          <a href={a.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line px-4 text-[15px]"><Icon n="ext" className="h-4 w-4" />{t('explorer')}</a></div>
      </Card>
      <Notice tone="warn">{t('onlySend', { assets: assets.join(' / '), network: n.name })}</Notice>
      {n.family === 'evm' && <Notice tone="info">{t('evmSame')}</Notice>}
      <Card><H>{t('addressFromSigner')}</H><ul className="space-y-2 text-[13.5px] text-mute">
        <li>{t('depositShown', { n: n.minConf })}</li>
        {n.tokens.length > 0 && <li>{t('gasNote', { sym: n.native.symbol })}</li>}
      </ul></Card>
    </div>
  );
}
