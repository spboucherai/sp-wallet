import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get } from './api';

export interface Bal { network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number; amount: string | null; display: string | null; error: string | null }
export interface Proposal { id: string; state: string; network: string; networkName: string; asset: string; symbol: string; decimals: number; amount: string; amountDisplay: string; from: string; to: string; note: string; memo: string | null;
  feeDisplay: string | null; maxFeeDisplay: string | null; feeSymbol: string; warnings: string[]; intentHash: string | null; txid: string | null; explorer: string | null; confirmations: number; error: string | null; createdAt: string; expiresAt: string | null;
  /** v11: the reason behind `error` as a code + parameters (translated by sv.ts), and the unified execution status */
  errorCode?: string | null; errorParams?: Record<string, string | number> | null; execution?: import('./execution').ExecutionV }
export interface Portfolio { asOf: string;
  /** NEXT (when the server sends it): is every network's balance in this answer, and which networks are missing */
  summary?: { complete: boolean; missing?: string[] } | null;
  /** v11: date of the oldest price shown, whether any is stale, and whether the signer answered (balances are the server's own reads either way) */
  pricesAsOf?: string | null; pricesStale?: boolean; signer?: { reachable: boolean; addressesAsOf: string };
  /** v11 (two price sources): where the displayed prices come from, which symbols fell back to the second source, which ones the two sources disagree on */
  priceSource?: 'coingecko' | 'apibricks' | 'mixed' | null; priceSources?: { primary: string; second: string | null; fallback: string[]; divergent: string[]; compared: number; maxDivergenceBps: number | null } | null;
  prices: Record<string, { source?: string; fallback?: boolean; divergent?: boolean; divergenceBps?: number | null; priceAt?: string | null; stale?: boolean; usd: number; cad: number; change24h: number | null; change7d: number | null; marketCap: number | null; volume24h: number | null; high24h: number | null; low24h: number | null; ath: number | null; rank: number | null; spark: number[] }> | null; balances: Bal[]; pending: Proposal[]; /** null = unknown (signer unreachable) */ halted: boolean | null }
export interface Net { id: string; name: string; family: string; native: { id: string; symbol: string; decimals: number }; tokens: { id: string; symbol: string; decimals: number }[]; minConf: number; explorerAddr: string; memo: 'text' | 'uint32' | null; activation: string | null;
  health: { ok: boolean; readable: boolean; identityVerified: boolean; height: number | null; endpoints: { url: string; ok: boolean; ms: number | null }[]; checkedAt: string } | null }
export interface SettingsT { locale: 'fr' | 'en'; currency: 'USD' | 'CAD'; hideBalances: boolean; prices: boolean; /** NEXT: appearance, the same on every device (absent on an older server) */ theme?: 'system' | 'light' | 'dark' }

/**
 * NEXT W4 — is the total partial? From the server's `summary` when present, and in any case from the rows it could not read
 * (`amount === null`): a network whose balance is unknown is NOT zero, and a total without it must say so. `missing` = names to show.
 */
export function portfolioGaps(p: Pick<Portfolio, 'balances' | 'summary'>): { partial: boolean; missing: string[] } {
  const name = (id: string) => p.balances.find((b) => b.network === id)?.networkName ?? id;
  const missing = [...new Set([...(p.summary?.missing ?? []).map(name), ...p.balances.filter((b) => b.amount === null).map((b) => b.networkName)])];
  return { partial: p.summary?.complete === false || missing.length > 0, missing };
}
/**
 * NEXT W5 — ONE rule for « can a transfer be started? », the same on every screen: not while the emergency halt is on, and not
 * while the signer cannot be reached (`halted === null` = unknown, which the server sends when the signer did not answer).
 */
export type SendBlock = 'halted' | 'signer' | null;
export const sendBlock = (p: Pick<Portfolio, 'halted' | 'signer'> | undefined): SendBlock => (!p ? null : p.halted ? 'halted' : p.halted === null || p.signer?.reachable === false ? 'signer' : null);
export const sendBlockKey = (b: Exclude<SendBlock, null>): 'nxSendOffHalted' | 'nxSendOffSigner' => (b === 'halted' ? 'nxSendOffHalted' : 'nxSendOffSigner');
export const usePortfolio = () => useQuery({ queryKey: ['portfolio'], queryFn: () => get<Portfolio>('/portfolio'), refetchInterval: 20_000 });
export const useNetworks = () => useQuery({ queryKey: ['networks'], queryFn: () => get<Net[]>('/networks'), refetchInterval: 60_000 });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => get<{ keyId: string; signerReachable?: boolean; addressesAsOf?: string; accounts: { network: string; name: string; family: string; address: string; explorer: string }[] }>('/accounts'), staleTime: 60_000 });
export function useSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsT>('/settings'), staleTime: 60_000 });
  // optimistic: the switch moves at once; the server's answer replaces it, a failure puts the previous value back (resolves false)
  const update = async (patch: Partial<SettingsT>): Promise<boolean> => {
    const prev = qc.getQueryData<SettingsT>(['settings']);
    if (prev) qc.setQueryData(['settings'], { ...prev, ...patch });
    try { qc.setQueryData(['settings'], await api<SettingsT>('PUT', '/settings', patch)); }
    catch { if (prev) qc.setQueryData(['settings'], prev); return false; }
    if ('currency' in patch || 'prices' in patch) void qc.invalidateQueries({ queryKey: ['portfolio'] });
    return true;
  };
  return { settings: q.data ?? { locale: 'fr', currency: 'CAD', hideBalances: false, prices: true } as SettingsT, update, /** the account's settings were read (not the defaults above) */ loaded: q.isSuccess };
}
