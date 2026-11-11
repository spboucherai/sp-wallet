// v8 hardening (D4): the SIMULATED positions of a spot agent (its paper book), as a card of its own on the agent page.
// It sits next to the real vault and is never mixed with it: its own border, its own title in capitals, its own total, and no
// figure of this card is added to a real balance. The data is the read-only `paper` field of GET /agents/:id.
import { useContext } from 'react';
import { I18n, useT } from '../i18n';
import { Coin, fiat, Icon, trimAmt, when } from '../ui';

export interface PaperBook { positions: { symbol: string; units: string; usd: number | null }[]; cashSymbol: string; cashUsd: number; asOf: number }

/** what the card shows, as plain data (tested without a browser): the total counts only what has a price, and says so */
export function paperSummary(p: PaperBook): { totalUsd: number; unpriced: string[]; rows: { symbol: string; units: string; usd: number | null; cash: boolean }[] } {
  const unpriced = p.positions.filter((x) => x.usd === null).map((x) => x.symbol);
  return {
    totalUsd: p.cashUsd + p.positions.reduce((s, x) => s + (x.usd ?? 0), 0), unpriced,
    rows: [...p.positions.map((x) => ({ ...x, cash: false })), { symbol: p.cashSymbol, units: String(p.cashUsd), usd: p.cashUsd, cash: true }],
  };
}
/** the card is for an agent that is not trading for real: in LIVE the vault above is the truth and the old paper book is not shown */
export const showPaperBook = (a: { state: string; paper?: PaperBook | null }): boolean => !!a.paper && a.state !== 'LIVE';

export function PaperBookCard({ paper }: { paper: PaperBook }) {
  const t = useT(); const { locale } = useContext(I18n);
  const s = paperSummary(paper);
  return (
    <section className="card overflow-hidden border-2 border-dashed border-blue/50" data-testid="paper-book" aria-label={t('hdPaperTitle')}>
      {/* the band of the card: pattern + icon + words — it says SIMULATION before any figure is read */}
      <div className="flex items-start gap-2.5 border-b border-dashed border-blue/40 bg-blue/10 px-5 py-3 text-blue" style={{ backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 12px, color-mix(in srgb, var(--blue) 7%, transparent) 12px 24px)' }}>
        <Icon n="eye" className="mt-px h-[18px] w-[18px] shrink-0" />
        <h2 className="min-w-0 text-[13.5px] font-extrabold uppercase leading-snug tracking-[0.05em]" data-testid="paper-book-title">{t('hdPaperTitle')}</h2></div>
      <div className="p-5">
        <div className="t-num text-[32px]" data-testid="paper-book-total">{fiat(s.totalUsd, 'USD', locale)}</div>
        <div className="mt-1.5 text-[13.5px] leading-snug text-mute">{t('hdPaperTotal')}{s.unpriced.length > 0 ? ` ${t('hdPaperUnpriced', { list: s.unpriced.join(', ') })}` : ''}</div>
        <ul className="mt-3 divide-y divide-line border-t border-line">{s.rows.map((x) => <li key={x.symbol} className="flex items-center gap-3.5 py-3" data-testid="paper-book-row">
          <Coin sym={x.symbol} size={40} />
          <span className="min-w-0 flex-1"><span className="block text-[15.5px] font-semibold">{x.symbol}</span><span className="block text-[12.5px] text-mute">{t(x.cash ? 'hdPaperCash' : 'hdPaperPosition')}</span></span>
          <span className="shrink-0 text-right"><span className="block text-[15.5px] font-semibold">{trimAmt(x.units, 8)}</span><span className="block text-[12.5px] text-mute">{x.usd !== null ? fiat(x.usd, 'USD', locale) : t('hdPaperNoPrice')}</span></span></li>)}</ul>
        <p className="mt-1 border-t border-line pt-3 text-[12.5px] leading-snug text-mute">{t('hdPaperNote', { date: when(new Date(paper.asOf), locale) })}</p>
      </div>
    </section>
  );
}
