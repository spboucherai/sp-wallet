// READ-ONLY smoke test of the API's own pre-deposit checks against the real networks: the two functions of
// services/api/src/derivatives/collateral.ts (`realChain`) that run before any deposit is prepared.
//     npx tsx scripts/smoke-hl-collateral.mts [wallet address, default: a fresh random one]
//   guards   — bridge bytecode = pinned on BOTH registry RPC endpoints, not paused, pays native USDC, wallet address has no code
//   liveness — the most recent transfers into the bridge are in the venue's ledger (POST /info, public, keyless)
// Nothing is signed, nothing is sent, no key is read; the exchange endpoint is never contacted; no database is opened.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { HL_BRIDGE_PINS } from '@spw/derivatives/live';

Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres://unused.invalid/none', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { realChain } = await import('../services/api/src/derivatives/collateral.ts');
const pin = HL_BRIDGE_PINS.mainnet!, me = process.argv[2] ?? privateKeyToAccount(generatePrivateKey()).address;
const chain = realChain();
const ledger = async (user: string, sinceMs: number) => {
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'userNonFundingLedgerUpdates', user, startTime: Math.floor(sinceMs) }), signal: AbortSignal.timeout(15000) });
  const a = await r.json() as { time: number; hash: string; delta: { type: string; usdc?: string; fee?: string; nonce?: number } }[];
  return a.map((x) => ({ time: x.time, hash: x.hash, type: x.delta.type, usdc: x.delta.usdc ?? null, fee: x.delta.fee ?? null, nonce: x.delta.nonce ?? null }));
};
let failed = 0;
try { await chain.guards(pin, me); console.log(`ok   guards: bridge ${pin.bridge} is the pinned bytecode on both RPC endpoints, not paused, pays ${pin.usdc}; ${me} carries no code`); }
catch (e) { failed++; console.log(`FAIL guards: ${(e as Error).message}`); }
try {
  const t0 = Date.now(), l = await chain.liveness(pin, ledger);
  console.log(`${l.ok ? 'ok  ' : 'FAIL'} liveness (${Date.now() - t0} ms): ${l.detail}`);
  for (const s of l.samples) console.log(`       ${s.usdc} USDC ${s.tx} → ${s.credited ? 'in the venue ledger' : 'NOT in the venue ledger'}`);
  if (!l.ok) failed++;
} catch (e) { failed++; console.log(`FAIL liveness: ${(e as Error).message}`); }
process.exit(failed ? 1 : 0);
