// V11 Risk — the limits editor: one real control per limit of the unified risk engine (no JSON). Tightening is saved at once;
// a change that loosens anything goes through the passkey (prepare → the list of what becomes looser → approve). An empty
// field is an ABSENT limit: in live mode the engine then denies new risk — it is never read as "unlimited".
import { useContext, useMemo, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { amountInputText, amountOf, sanitizeAmountText } from '../amount';
import { AmountProblem } from '../amountUi';
import { post } from '../api';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Field, Icon, inputCls, Notice, Tag } from '../ui';

export interface LimitsView {
  mode: 'paper' | 'live'; stored: Record<string, unknown>; defaults: Record<string, unknown>; effective: Record<string, unknown>; missing: string[];
  effectiveOwner?: Record<string, unknown>; missingForAutomation?: string[]; ownerOrdersRefused?: boolean; automationOrdersRefused?: boolean;
  seed?: { at: number; limits: Record<string, unknown>; sources: { field: string; from: string; accounts: string[] }[]; notSeeded: string[]; accounts: { id: string; venue: string; network: string }[] };
}
type Kind = 'dec' | 'int' | 'list' | 'keyed' | 'keyedInt' | 'liquidity';
/** every member of RiskLimitsSchema (packages/trading/src/risk/engine.ts), grouped as the screen shows them */
export const LIMIT_GROUPS: { id: string; fields: { key: string; kind: Kind; unit?: 'usd' | 'bps' | 'x' | 'ms' }[] }[] = [
  { id: 'scope', fields: [{ key: 'allowedVenues', kind: 'list' }, { key: 'allowedInstruments', kind: 'list' }] },
  { id: 'size', fields: [{ key: 'maxOrderNotional', kind: 'dec', unit: 'usd' }, { key: 'maxDailyNotional', kind: 'dec', unit: 'usd' }, { key: 'maxPositionNotional', kind: 'keyed', unit: 'usd' }, { key: 'maxOrderLeverage', kind: 'dec', unit: 'x' }, { key: 'maxAccountLeverage', kind: 'dec', unit: 'x' }] },
  { id: 'exposure', fields: [{ key: 'maxGrossExposure', kind: 'dec', unit: 'usd' }, { key: 'maxNetExposure', kind: 'dec', unit: 'usd' }, { key: 'maxAssetExposure', kind: 'keyed', unit: 'usd' }, { key: 'maxVenueExposure', kind: 'keyed', unit: 'usd' }, { key: 'maxVenueCollateralShareBps', kind: 'dec', unit: 'bps' }] },
  { id: 'loss', fields: [{ key: 'maxDailyLoss', kind: 'dec', unit: 'usd' }, { key: 'maxTotalLoss', kind: 'dec', unit: 'usd' }, { key: 'maxDrawdownBps', kind: 'dec', unit: 'bps' }, { key: 'minLiquidationDistanceBps', kind: 'dec', unit: 'bps' }] },
  { id: 'quality', fields: [{ key: 'maxSlippageBps', kind: 'dec', unit: 'bps' }, { key: 'minLiquidity', kind: 'liquidity' }, { key: 'maxPriceAgeMs', kind: 'keyedInt', unit: 'ms' }, { key: 'maxBookAgeMs', kind: 'int', unit: 'ms' }, { key: 'minPriceSources', kind: 'int' }, { key: 'maxSourceDeviationBps', kind: 'dec', unit: 'bps' }] },
  { id: 'rate', fields: [{ key: 'maxOrdersPerMinute', kind: 'int' }, { key: 'maxOrdersPerHour', kind: 'int' }, { key: 'maxOrdersPerDay', kind: 'int' }] },
];
interface KeyedDraft { def: string; per: [string, string][] }
type Draft = Record<string, string | KeyedDraft | { withinBps: string; multiple: string }>;
const isKeyed = (k: Kind): boolean => k === 'keyed' || k === 'keyedInt';

/** how a stored value reads in a list of facts (never JSON for the owner) */
export function limitText(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '∅';
  if (typeof v === 'object') {
    const o = v as { per?: Record<string, unknown>; default?: unknown; withinBps?: unknown; multiple?: unknown };
    if (o.withinBps !== undefined) return `${String(o.multiple)}× ≤ ${String(o.withinBps)} bps`;
    const per = Object.entries(o.per ?? {}).map(([k, x]) => `${k}: ${String(x)}`);
    return [o.default !== undefined ? String(o.default) : null, ...per].filter((x) => x !== null).join(' · ') || '—';
  }
  return String(v);
}
function toDraft(stored: Record<string, unknown>, locale: 'fr' | 'en'): Draft {
  const d: Draft = {}, txt = (x: unknown): string => (x === undefined || x === null ? '' : amountInputText(String(x), locale));
  for (const g of LIMIT_GROUPS) for (const f of g.fields) {
    const v = stored[f.key];
    if (isKeyed(f.kind)) { const o = (v ?? {}) as { per?: Record<string, unknown>; default?: unknown }; d[f.key] = { def: txt(o.default), per: Object.entries(o.per ?? {}).map(([k, x]) => [k, txt(x)] as [string, string]) }; }
    else if (f.kind === 'liquidity') { const o = (v ?? {}) as { withinBps?: unknown; multiple?: unknown }; d[f.key] = { withinBps: txt(o.withinBps), multiple: txt(o.multiple) }; }
    else if (f.kind === 'list') d[f.key] = Array.isArray(v) ? (v as string[]).join(', ') : '';
    else d[f.key] = txt(v);
  }
  return d;
}
const INT = /^\d{1,12}$/;
/** the draft as the limit set the server stores; `bad` names the fields whose text cannot be read */
export function fromDraft(d: Draft, locale: 'fr' | 'en'): { limits: Record<string, unknown>; bad: string[] } {
  const limits: Record<string, unknown> = {}, bad: string[] = [];
  const dec = (s: string, key: string): string | null => { const v = amountOf(s, locale); if (v === null) { bad.push(key); return null; } return v; };
  const int = (s: string, key: string): number | null => { if (!INT.test(s.trim())) { bad.push(key); return null; } return Number(s.trim()); };
  for (const g of LIMIT_GROUPS) for (const f of g.fields) {
    const v = d[f.key];
    if (v === undefined) continue;
    if (typeof v === 'string') {
      if (v.trim() === '') continue;
      if (f.kind === 'list') limits[f.key] = [...new Set(v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
      else if (f.kind === 'int') { const n = int(v, f.key); if (n !== null) limits[f.key] = n; }
      else { const x = dec(v, f.key); if (x !== null) limits[f.key] = x; }
    } else if ('per' in v) {
      const per: Record<string, string | number> = {}; let any = v.def.trim() !== '';
      const one = (s: string) => (f.kind === 'keyedInt' ? int(s, f.key) : dec(s, f.key));
      for (const [k, x] of v.per) { if (!k.trim() && !x.trim()) continue; if (!k.trim()) { bad.push(f.key); continue; } const n = one(x); if (n !== null) { per[k.trim()] = n; any = true; } }
      if (!any) continue;
      const def = v.def.trim() === '' ? undefined : one(v.def);
      limits[f.key] = { per, ...(def !== undefined && def !== null ? { default: def } : {}) };
    } else {
      if (v.withinBps.trim() === '' && v.multiple.trim() === '') continue;
      const a = dec(v.withinBps, f.key), b = dec(v.multiple, f.key);
      if (a !== null && b !== null) limits[f.key] = { withinBps: a, multiple: b };
    }
  }
  return { limits, bad: [...new Set(bad)] };
}

const UNIT: Record<string, string> = { usd: 'USD', bps: 'bps', x: '×', ms: 'ms' };
export function LimitsEditor({ view, onDone, onCancel, onError }: { view: LimitsView; onDone: () => void; onCancel: () => void; onError: (e: unknown) => string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [d, setD] = useState<Draft>(() => toDraft(view.stored, locale));
  const [busy, setBusy] = useState(false); const [fail, setFail] = useState(''); const [loosened, setLoosened] = useState<string[] | null>(null);
  const built = useMemo(() => fromDraft(d, locale), [d, locale]);
  const set = (k: string, v: Draft[string]) => { setD((x) => ({ ...x, [k]: v })); setLoosened(null); };
  const seeded = new Map((view.seed?.sources ?? []).map((s) => [s.field, s.from]));
  const save = async (confirmed: boolean) => {
    if (built.bad.length) return;
    setBusy(true); setFail('');
    try {
      const p = await post(`/risk/limits/${view.mode}/prepare`, { limits: built.limits });
      if (!p.needed) { await post(`/risk/limits/${view.mode}`, { limits: built.limits }); onDone(); return; }
      if (!confirmed) { setLoosened(p.loosened as string[]); return; }                    // shown first: which limits become looser
      await post(`/risk/limits/${view.mode}/approve`, { assertion: await startAuthentication({ optionsJSON: p.options }) });
      onDone();
    } catch (e) { setFail(onError(e)); } finally { setBusy(false); }
  };
  const ph = (key: string): string => { const v = (view.effectiveOwner ?? view.effective)[key]; return v === undefined ? t('rkUnset') : limitText(v); };
  const num = (key: string, value: string, on: (s: string) => void, testid?: string) => (
    <input className={inputCls} inputMode="decimal" autoComplete="off" value={value} placeholder={ph(key)} onChange={(e) => on(sanitizeAmountText(e.target.value))} data-testid={testid ?? `rk-lim-${key}`} />);
  return (
    <div className="space-y-4" data-testid="rk-limits-form">
      <Notice tone="info">{t('rkLimitsHint')}</Notice>
      {LIMIT_GROUPS.map((g) => <fieldset key={g.id} className="space-y-3">
        <legend className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t(`rkLG_${g.id}` as Key)}</legend>
        {g.fields.map((f) => {
          const v = d[f.key], missing = view.missing.includes(f.key), hint = <span>{t(`rkLH_${f.key}` as Key)}{f.unit ? ` (${UNIT[f.unit]})` : ''}{seeded.has(f.key) && !(f.key in view.stored) ? <> · <b>{t('rkSeeded')}</b> {seeded.get(f.key)}</> : null}</span>;
          const label = `${t(`rkL_${f.key}` as Key)}${missing ? ` — ${t('rkRequired')}` : ''}`;
          if (typeof v === 'string') return <Field key={f.key} label={label} hint={hint}>
            {f.kind === 'list' ? <input className={inputCls} autoComplete="off" autoCapitalize="none" spellCheck={false} value={v} placeholder={ph(f.key)} onChange={(e) => set(f.key, e.target.value)} data-testid={`rk-lim-${f.key}`} />
              : num(f.key, v, (s) => set(f.key, s))}
            {f.kind === 'dec' && <AmountProblem text={v} />}{f.kind === 'int' && v.trim() !== '' && !INT.test(v.trim()) && <span role="alert" className="mt-1.5 block text-[12.5px] text-danger">{t('rkWhole')}</span>}
          </Field>;
          if (v && 'per' in v) return <Field key={f.key} label={label} hint={hint}>
            <div className="space-y-2">
              {num(f.key, v.def, (s) => set(f.key, { ...v, def: s }))}
              {v.per.map(([k, x], i) => <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <input className={inputCls} autoCapitalize="none" spellCheck={false} aria-label={t('rkPerKey')} placeholder={t(f.key === 'maxPositionNotional' ? 'rkPerInstrument' : f.key === 'maxAssetExposure' ? 'rkPerAsset' : f.key === 'maxVenueExposure' ? 'rkPerVenue' : 'rkPerSource')} value={k}
                  onChange={(e) => set(f.key, { ...v, per: v.per.map((p, j) => (j === i ? [e.target.value, p[1]] : p)) })} />
                <input className={inputCls} inputMode="decimal" aria-label={t('rkPerValue')} value={x} onChange={(e) => set(f.key, { ...v, per: v.per.map((p, j) => (j === i ? [p[0], sanitizeAmountText(e.target.value)] : p)) })} />
                <Btn kind="ghost" aria-label={t('rkRemove')} onClick={() => set(f.key, { ...v, per: v.per.filter((_, j) => j !== i) })}><Icon n="x" className="h-4 w-4" /></Btn></div>)}
              <Btn kind="ghost" onClick={() => set(f.key, { ...v, per: [...v.per, ['', '']] })}><Icon n="plus" className="h-4 w-4" />{t('rkAddOverride')}</Btn>
            </div></Field>;
          if (v && 'withinBps' in v) return <Field key={f.key} label={label} hint={hint}>
            <div className="grid grid-cols-2 gap-2">{num(f.key, v.multiple, (s) => set(f.key, { ...v, multiple: s }), 'rk-lim-minLiquidity-multiple')}{num(f.key, v.withinBps, (s) => set(f.key, { ...v, withinBps: s }), 'rk-lim-minLiquidity-within')}</div></Field>;
          return null;
        })}
      </fieldset>)}
      {built.bad.length > 0 && <Notice tone="danger">{t('rkBadFields')} <span className="font-mono text-[12.5px]">{built.bad.join(', ')}</span></Notice>}
      {loosened && <Notice tone="warn"><b>{t('rkLoosens')}</b> <span className="font-mono text-[12.5px]" data-testid="rk-loosened">{loosened.join(', ')}</span> — {t('rkLoosensBody')}</Notice>}
      {fail && <Notice tone="danger">{fail}</Notice>}
      <div className="grid grid-cols-2 gap-2.5"><Btn kind="ghost" onClick={onCancel}>{t('cancel')}</Btn>
        <Btn busy={busy} disabled={built.bad.length > 0} onClick={() => void save(loosened !== null)} data-testid="rk-limits-save">{loosened ? <><Icon n="key" className="h-4 w-4" />{t('approve')}</> : t('rkSave')}</Btn></div>
      {loosened === null && <p className="text-[12.5px] leading-snug text-mute"><Tag tone="info">{t('rkTightenFree')}</Tag></p>}
    </div>);
}
