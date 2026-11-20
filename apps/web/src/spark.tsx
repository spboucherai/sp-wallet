// The tiny trend line of a list row — a module of its own: the dashboard's first paint needs it, not the rest of chart.tsx.
/** Tiny trend line for list rows. Decorative: the adjacent text carries the value. */
export function Spark({ data, w = 64, h = 26 }: { data: number[]; w?: number; h?: number }) {
  if (data.length < 2) return <span style={{ width: w, height: h }} className="inline-block" />;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const d = data.map((v, k) => `${k ? 'L' : 'M'}${((k / (data.length - 1)) * (w - 2) + 1).toFixed(1)} ${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join('');
  const ly = h - 2 - ((data[data.length - 1]! - min) / span) * (h - 4);
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0 overflow-visible text-mute"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" /><circle cx={w - 1} cy={ly} r="2" fill="currentColor" /></svg>;
}

