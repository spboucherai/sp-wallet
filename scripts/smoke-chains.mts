import { adapters } from '../services/api/src/chains/index.ts';
const addr: Record<string,string> = { ethereum:'0x9858EfFD232B4033E47d90003D41EC34EcaEda94', base:'0x9858EfFD232B4033E47d90003D41EC34EcaEda94', arbitrum:'0x9858EfFD232B4033E47d90003D41EC34EcaEda94', polygon:'0x9858EfFD232B4033E47d90003D41EC34EcaEda94', bitcoin:'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', solana:'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' };
for (const [id,a] of Object.entries(adapters)) {
  try { const h = await a.health(); const b = await a.balances(addr[id]!);
    console.log(id, h.ok, h.identityVerified, h.height, h.endpoints.map(e=>`${e.url}:${e.ok}:${e.ms}`).join(' '), JSON.stringify(b, (_k,v)=>typeof v==='bigint'?v.toString():v));
    const d = await a.deposits(addr[id]!, null); console.log('  deposits', d.items.length, d.cursor);
  } catch(e) { console.log(id, 'ERR', (e as Error).message); }
}
