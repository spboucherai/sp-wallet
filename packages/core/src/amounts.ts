// Exact integer money arithmetic. No floating point anywhere.
const MAX = (1n << 256n) - 1n;

export function parseUnits(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('bad decimals');
  const s = input.trim().replace(',', '.');
  if (!/^\d{1,60}(\.\d{0,60})?$/.test(s)) throw new Error('invalid amount');
  const [int = '0', frac = ''] = s.split('.');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error('too many decimals');
  const v = BigInt(int) * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '').padEnd(decimals, '0') || '0');
  if (v > MAX) throw new Error('amount overflow');
  return v;
}

export function formatUnits(value: bigint, decimals: number): string {
  if (value < 0n) throw new Error('negative amount');
  const base = 10n ** BigInt(decimals);
  const int = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int.toString();
}

/** Parse a canonical base-unit string ("0" or no leading zero, digits only). */
export function baseUnits(s: string): bigint {
  if (!/^(0|[1-9]\d{0,77})$/.test(s)) throw new Error('invalid base-unit integer');
  return BigInt(s);
}
