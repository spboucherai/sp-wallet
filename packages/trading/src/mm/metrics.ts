// What a quoting session is measured by: markouts per fill (adverse selection) and an exact PnL attribution. Pure.
//
// Markout of a fill at horizon h: where the mid is h after the fill, against the fill price, signed so that NEGATIVE is adverse
// selection (bought and the market went down, sold and it went up):   buy: (mid_h − px) / px      sell: (px − mid_h) / px
//
// Attribution (exact decimals; the identity is property-tested):
//   total = cash + position × mid  =  spread capture + inventory PnL + fees + funding
//   spread capture  Σ over fills of the distance between the fill price and the mid AT the fill (buy: mid − px; sell: px − mid) × size
//   inventory PnL   Σ over mid changes of the position held × the change
//   fees            negative = paid, positive = rebate (the venue's own sign is the opposite: `fee` positive = paid)
import { D, type Dec, type DecStr } from '@spw/derivatives';
import type { Side } from './types.ts';

export const MARKOUT_HORIZONS_MS = [1000, 10_000, 60_000] as const;
export interface MarkoutFill { id: string; ts: number; side: Side; price: DecStr; size: DecStr; /** bps per horizon (4 decimals); null until the horizon has passed and a mid was seen */ bps: (DecStr | null)[] }
export interface MarkoutState { fills: MarkoutFill[]; /** fills that still wait for a horizon */ open: number }
export const markoutInit = (): MarkoutState => ({ fills: [], open: 0 });
export function markoutAddFill(s: MarkoutState, f: { id: string; ts: number; side: Side; price: DecStr; size: DecStr }, keep = 2000): MarkoutState {
  if (s.fills.some((x) => x.id === f.id)) return s;
  const fills = [...s.fills, { ...f, bps: MARKOUT_HORIZONS_MS.map(() => null) }];
  return { fills: fills.slice(-keep), open: s.open + 1 };
}
/** a mid observed at `ts`: every horizon that has passed for a fill takes the FIRST mid seen at or after it */
export function markoutOnMid(s: MarkoutState, ts: number, mid: DecStr): MarkoutState {
  if (s.open === 0) return s;
  const m = D.from(mid);
  if (!D.isPos(m)) return s;
  let open = 0;
  const fills = s.fills.map((f) => {
    if (f.bps.every((x) => x !== null)) return f;
    const px = D.from(f.price), now = D.str(D.div(D.mul(f.side === 'buy' ? D.sub(m, px) : D.sub(px, m), D.from(10000n)), px, 4, 'half_even'));
    const bps = f.bps.map((x, k) => (x !== null || ts < f.ts + MARKOUT_HORIZONS_MS[k]! ? x : now));
    if (bps.some((x) => x === null)) open += 1;
    return { ...f, bps };
  });
  return { fills, open };
}
export interface MarkoutSummary { horizonMs: number; fills: number; meanBps: DecStr | null; /** weighted by the notional of each fill */ weightedMeanBps: DecStr | null; worstBps: DecStr | null }
export function markoutSummary(s: MarkoutState): MarkoutSummary[] {
  return MARKOUT_HORIZONS_MS.map((h, k) => {
    const xs = s.fills.filter((f) => f.bps[k] !== null).map((f) => ({ b: D.from(f.bps[k]!), w: D.mul(D.from(f.size), D.from(f.price)) }));
    if (!xs.length) return { horizonMs: h, fills: 0, meanBps: null, weightedMeanBps: null, worstBps: null };
    const w = xs.reduce((a, x) => D.add(a, x.w), D.zero), sum = xs.reduce((a, x) => D.add(a, x.b), D.zero);
    return { horizonMs: h, fills: xs.length, meanBps: D.str(D.div(sum, D.from(BigInt(xs.length)), 4, 'half_even')),
      weightedMeanBps: D.isPos(w) ? D.str(D.div(xs.reduce((a, x) => D.add(a, D.mul(x.b, x.w)), D.zero), w, 4, 'half_even')) : null, worstBps: D.str(xs.map((x) => x.b).reduce(D.min)) };
  });
}
/** the 10 s markouts (bps) of the fills that have one, oldest first — the breaker's input */
export const markouts10s = (s: MarkoutState): DecStr[] => s.fills.map((f) => f.bps[1]).filter((x): x is DecStr => x !== null && x !== undefined);

// ---------------------------------------------------------------------------------------------------------------------------
export interface PnlState { position: DecStr; cash: DecStr; lastMid: DecStr | null; spread: DecStr; inventory: DecStr; fees: DecStr; funding: DecStr; fills: number; volume: DecStr }
export const pnlInit = (): PnlState => ({ position: '0', cash: '0', lastMid: null, spread: '0', inventory: '0', fees: '0', funding: '0', fills: 0, volume: '0' });
const d = D.from, s = D.str;
/** the mid moved: the position held earns or loses the change */
export function pnlOnMid(p: PnlState, mid: DecStr): PnlState {
  if (p.lastMid === null) return { ...p, lastMid: s(d(mid)) };
  return { ...p, lastMid: s(d(mid)), inventory: s(D.add(d(p.inventory), D.mul(d(p.position), D.sub(d(mid), d(p.lastMid))))) };
}
/** a fill of ours. `fee`: the venue's number — positive = paid, negative = rebate. `mid`: the mid at the fill. */
export function pnlOnFill(p0: PnlState, f: { side: Side; price: DecStr; size: DecStr; fee: DecStr; mid: DecStr }): PnlState {
  const p = pnlOnMid(p0, f.mid), px = d(f.price), sz = d(f.size), mid = d(f.mid), buy = f.side === 'buy';
  const edge: Dec = D.mul(buy ? D.sub(mid, px) : D.sub(px, mid), sz);
  return { ...p, position: s(buy ? D.add(d(p.position), sz) : D.sub(d(p.position), sz)), cash: s(D.sub(buy ? D.sub(d(p.cash), D.mul(px, sz)) : D.add(d(p.cash), D.mul(px, sz)), d(f.fee))),
    spread: s(D.add(d(p.spread), edge)), fees: s(D.sub(d(p.fees), d(f.fee))), fills: p.fills + 1, volume: s(D.add(d(p.volume), D.mul(px, sz))) };
}
/** a funding payment: positive = received */
export const pnlOnFunding = (p: PnlState, usd: DecStr): PnlState => ({ ...p, cash: s(D.add(d(p.cash), d(usd))), funding: s(D.add(d(p.funding), d(usd))) });
export interface PnlReport { totalUsd: DecStr; spreadCaptureUsd: DecStr; inventoryPnlUsd: DecStr; feesUsd: DecStr; fundingUsd: DecStr; position: DecStr; fills: number; volumeUsd: DecStr; /** total ÷ volume, bps (4 decimals); null without volume */ bpsOfVolume: DecStr | null }
export function pnlReport(p: PnlState): PnlReport {
  const total = D.add(D.add(d(p.spread), d(p.inventory)), D.add(d(p.fees), d(p.funding)));
  return { totalUsd: s(total), spreadCaptureUsd: p.spread, inventoryPnlUsd: p.inventory, feesUsd: p.fees, fundingUsd: p.funding, position: p.position, fills: p.fills, volumeUsd: p.volume,
    bpsOfVolume: D.isPos(d(p.volume)) ? s(D.div(D.mul(total, d('10000')), d(p.volume), 4, 'half_even')) : null };
}
/** mark-to-market from the cash and the position — must equal the attributed total (the identity) */
export const pnlMarkToMarket = (p: PnlState): DecStr => s(D.add(d(p.cash), D.mul(d(p.position), d(p.lastMid ?? '0'))));
