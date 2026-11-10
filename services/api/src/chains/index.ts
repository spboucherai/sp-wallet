import { NETWORKS, type NetworkId } from '@spw/core';
import { btcAdapter } from './btc.ts';
import { evmAdapter } from './evm.ts';
import { solAdapter } from './sol.ts';
import type { Adapter } from './rpc.ts';

export const adapters = Object.fromEntries(Object.values(NETWORKS).map((n) =>
  [n.id, n.family === 'evm' ? evmAdapter(n) : n.family === 'btc' ? btcAdapter(n) : solAdapter(n)])) as Record<NetworkId, Adapter>;
export * from './rpc.ts';
