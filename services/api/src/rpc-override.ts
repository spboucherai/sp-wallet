// TEST ONLY. Lets an integration test point a network at a local fork (anvil). Never set in production: the API prints a
// loud warning at start when it is.
import { NETWORKS } from '@spw/core';
const raw = process.env.SPW_RPC_OVERRIDE;
if (raw) {
  const map = JSON.parse(raw) as Record<string, string[]>;
  for (const [id, urls] of Object.entries(map)) { const n = NETWORKS[id]; if (!n) throw new Error(`SPW_RPC_OVERRIDE: unknown network ${id}`); n.rpc = urls; }
  console.warn(`\n*** SPW_RPC_OVERRIDE is set: ${Object.keys(map).join(', ')} do NOT use their real endpoints. This must never happen in production. ***\n`);
}
export const rpcOverridden = !!raw;
