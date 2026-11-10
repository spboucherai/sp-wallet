// Live read-only check of every network adapter (identity, token verification, balances, deposit scan) using a public test address.
import { NETWORKS } from '@spw/core';
import { adapters } from '../services/api/src/chains/index.ts';
const addr: Record<string, string> = { evm: process.env.EVM_ADDR ?? '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', btc: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', sol: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' };
for (const n of Object.values(NETWORKS)) {
  const a = adapters[n.id];
  try {
    const h = await a.health(); const b = await a.balances(addr[n.family]!);
    const nz = Object.entries(b).filter(([, v]) => v > 0n).map(([k, v]) => `${k === 'native' ? n.native.symbol : n.tokens.find((t) => t.id === k)?.symbol}=${v}`);
    console.log(n.id.padEnd(10), 'ok=' + h.ok, 'identity=' + h.identityVerified, 'tokens=' + n.tokens.length, 'read=' + (Object.keys(b).length - 1), 'disabled=' + (a.disabledAssets?.().length ?? 0), 'nonzero:', nz.join(' ') || '-');
    const d = await a.deposits(addr[n.family]!, null); console.log('           deposits', d.items.length);
  } catch (e) { console.log(n.id, 'ERR', (e as Error).message); }
}
