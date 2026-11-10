import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get } from './api';

export interface Bal { network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number; amount: string | null; display: string | null; error: string | null }
export interface Proposal { id: string; state: string; network: string; networkName: string; asset: string; symbol: string; decimals: number; amount: string; amountDisplay: string; from: string; to: string; note: string; memo: string | null;
  feeDisplay: string | null; maxFeeDisplay: string | null; feeSymbol: string; warnings: string[]; intentHash: string | null; txid: string | null; explorer: string | null; confirmations: number; error: string | null; createdAt: string; expiresAt: string | null }
export interface Portfolio { asOf: string; prices: Record<string, { usd: number; cad: number; change24h: number | null; change7d: number | null; marketCap: number | null; volume24h: number | null; high24h: number | null; low24h: number | null; ath: number | null; rank: number | null; spark: number[] }> | null; balances: Bal[]; pending: Proposal[]; halted: boolean }
export interface Net { id: string; name: string; family: string; native: { id: string; symbol: string; decimals: number }; tokens: { id: string; symbol: string; decimals: number }[]; minConf: number; explorerAddr: string; memo: 'text' | 'uint32' | null; activation: string | null;
  health: { ok: boolean; readable: boolean; identityVerified: boolean; height: number | null; endpoints: { url: string; ok: boolean; ms: number | null }[]; checkedAt: string } | null }
export interface SettingsT { locale: 'fr' | 'en'; currency: 'USD' | 'CAD'; hideBalances: boolean; prices: boolean }

export const usePortfolio = () => useQuery({ queryKey: ['portfolio'], queryFn: () => get<Portfolio>('/portfolio'), refetchInterval: 20_000 });
export const useNetworks = () => useQuery({ queryKey: ['networks'], queryFn: () => get<Net[]>('/networks'), refetchInterval: 60_000 });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => get<{ keyId: string; accounts: { network: string; name: string; family: string; address: string; explorer: string }[] }>('/accounts'), staleTime: 60_000 });
export function useSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsT>('/settings'), staleTime: 60_000 });
  const update = async (patch: Partial<SettingsT>) => { qc.setQueryData(['settings'], await api<SettingsT>('PUT', '/settings', patch)); void qc.invalidateQueries({ queryKey: ['portfolio'] }); };
  return { settings: q.data ?? { locale: 'fr', currency: 'CAD', hideBalances: false, prices: true } as SettingsT, update };
}
