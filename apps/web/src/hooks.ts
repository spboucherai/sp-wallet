import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get } from './api';

export interface Bal { network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number; amount: string | null; display: string | null; error: string | null }
export interface Proposal { id: string; state: string; network: string; networkName: string; asset: string; symbol: string; decimals: number; amount: string; amountDisplay: string; from: string; to: string; note: string; memo: string | null;
  feeDisplay: string | null; maxFeeDisplay: string | null; feeSymbol: string; warnings: string[]; intentHash: string | null; txid: string | null; explorer: string | null; confirmations: number; error: string | null; createdAt: string; expiresAt: string | null;
  /** v11: the reason behind `error` as a code + parameters (translated by sv.ts), and the unified execution status */
  errorCode?: string | null; errorParams?: Record<string, string | number> | null; execution?: import('./execution').ExecutionV }
export interface Portfolio { asOf: string;
  /** v11: date of the oldest price shown, whether any is stale, and whether the signer answered (balances are the server's own reads either way) */
  pricesAsOf?: string | null; pricesStale?: boolean; signer?: { reachable: boolean; addressesAsOf: string };
  /** v11 (two price sources): where the displayed prices come from, which symbols fell back to the second source, which ones the two sources disagree on */
  priceSource?: 'coingecko' | 'apibricks' | 'mixed' | null; priceSources?: { primary: string; second: string | null; fallback: string[]; divergent: string[]; compared: number; maxDivergenceBps: number | null } | null;
  prices: Record<string, { source?: string; fallback?: boolean; divergent?: boolean; divergenceBps?: number | null; priceAt?: string | null; stale?: boolean; usd: number; cad: number; change24h: number | null; change7d: number | null; marketCap: number | null; volume24h: number | null; high24h: number | null; low24h: number | null; ath: number | null; rank: number | null; spark: number[] }> | null; balances: Bal[]; pending: Proposal[]; /** null = unknown (signer unreachable) */ halted: boolean | null }
export interface Net { id: string; name: string; family: string; native: { id: string; symbol: string; decimals: number }; tokens: { id: string; symbol: string; decimals: number }[]; minConf: number; explorerAddr: string; memo: 'text' | 'uint32' | null; activation: string | null;
  health: { ok: boolean; readable: boolean; identityVerified: boolean; height: number | null; endpoints: { url: string; ok: boolean; ms: number | null }[]; checkedAt: string } | null }
export interface SettingsT { locale: 'fr' | 'en'; currency: 'USD' | 'CAD'; hideBalances: boolean; prices: boolean }

export const usePortfolio = () => useQuery({ queryKey: ['portfolio'], queryFn: () => get<Portfolio>('/portfolio'), refetchInterval: 20_000 });
export const useNetworks = () => useQuery({ queryKey: ['networks'], queryFn: () => get<Net[]>('/networks'), refetchInterval: 60_000 });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => get<{ keyId: string; signerReachable?: boolean; addressesAsOf?: string; accounts: { network: string; name: string; family: string; address: string; explorer: string }[] }>('/accounts'), staleTime: 60_000 });
export function useSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsT>('/settings'), staleTime: 60_000 });
  const update = async (patch: Partial<SettingsT>) => { qc.setQueryData(['settings'], await api<SettingsT>('PUT', '/settings', patch)); void qc.invalidateQueries({ queryKey: ['portfolio'] }); };
  return { settings: q.data ?? { locale: 'fr', currency: 'CAD', hideBalances: false, prices: true } as SettingsT, update };
}
