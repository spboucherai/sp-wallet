import { associatedTokenAddress, buildSolMessage, getAsset, solFeeLamports, solWireTransaction, SYSTEM_PROGRAM, type Intent, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, rpcAny, rpcOne, rpcQuorum, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

const RENT_ATA = 2_039_280n; // rent-exempt minimum for a 165-byte token account
const RENT_SYSTEM = 890_880n; // rent-exempt minimum for a 0-byte system account

export function solAdapter(n: NetworkDef): Adapter {
  const call = <T>(m: string, p: unknown[]) => rpcAny<T>(n.rpc, m, p);
  let identity = false;
  const acct = (a: string) => call<{ value: { owner: string; lamports: number; data: unknown } | null }>('getAccountInfo', [a, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const tokenBalance = async (owner: string, mint: string): Promise<bigint> => {
    const r = await call<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return r.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  };
  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(n.rpc.map(async (url) => {
        const t = Date.now();
        try {
          const h = await rpcOne<number>(url, 'getBlockHeight', [{ commitment: 'confirmed' }]);
          if (!identity && (await rpcOne<string>(url, 'getGenesisHash', [])) !== n.chainRef) throw new Error('genesis');
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h };
        } catch { return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.every((e) => e.ok);
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },
    async balances(addr) {
      const out: Record<string, bigint> = { native: BigInt((await call<{ value: number }>('getBalance', [addr, { commitment: 'confirmed' }])).value) };
      for (const t of n.tokens) out[t.id] = await tokenBalance(addr, t.id);
      return out;
    },
    async prepare(d): Promise<Prepared> {
      if ((await rpcQuorum<string>(n.rpc, 'getGenesisHash', [])) !== n.chainRef) throw new UserError('rpc_degraded', 'cluster identity mismatch; transfer refused', 503);
      const asset = getAsset(n.id, d.asset), warnings: string[] = [];
      const dest = (await acct(d.to)).value;
      if (dest && dest.owner !== SYSTEM_PROGRAM) throw new UserError('bad_destination', 'destination is not a regular wallet address (it is a program-owned or token account)');
      const bal = await this.balances(d.from);
      const computeUnitLimit = asset.id === 'native' ? 5_000 : 80_000;
      let price = 5_000n;
      try {
        const fees = await call<{ prioritizationFee: number }[]>('getRecentPrioritizationFees', [[d.from]]);
        const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
        price = BigInt(Math.min(2_000_000, Math.max(5_000, sorted[Math.floor(sorted.length * 0.75)] ?? 0)));
      } catch { /* default */ }
      const fee = solFeeLamports(computeUnitLimit, price);
      let createAta = false, needLamports = fee;
      if (asset.id === 'native') {
        if (!dest && d.amount < RENT_SYSTEM) throw new UserError('below_rent', 'destination account does not exist yet: send at least 0.00089088 SOL');
        needLamports += d.amount;
        // keep the source account rent-exempt
        if ((bal.native ?? 0n) - needLamports < RENT_SYSTEM && (bal.native ?? 0n) !== needLamports) throw new UserError('insufficient_funds', 'insufficient SOL (0.00089088 SOL must remain in the wallet)');
      } else {
        if ((bal[asset.id] ?? 0n) < d.amount) throw new UserError('insufficient_funds', `insufficient ${asset.symbol} balance`);
        const srcAta = (await acct(associatedTokenAddress(d.from, asset.id))).value;
        if (!srcAta) throw new UserError('insufficient_funds', `no ${asset.symbol} token account in this wallet`);
        createAta = !(await acct(associatedTokenAddress(d.to, asset.id))).value;
        if (createAta) { needLamports += RENT_ATA; warnings.push('creates_token_account'); }
        if ((bal.native ?? 0n) < needLamports) throw new UserError('insufficient_gas', 'not enough SOL to pay the network fee' + (createAta ? ' and the recipient token account rent (≈0.00204 SOL)' : ''));
      }
      const bh = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return { section: { sol: { recentBlockhash: bh.value.blockhash, lastValidBlockHeight: bh.value.lastValidBlockHeight, createAta, computeUnitLimit, computeUnitPrice: price.toString() } },
        maxFee: fee, feeEstimate: fee, warnings, ttlSec: 50 };
    },
    async broadcast(raw) {
      const rs = await Promise.allSettled(n.rpc.map((u) => rpcOne<string>(u, 'sendTransaction', [raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }])));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      const msg = String((rs[0] as PromiseRejectedResult).reason?.message);
      if (/already been processed/i.test(msg)) return;
      throw new Error(msg);
    },
    async track(p): Promise<Tracked> {
      const r = await call<{ value: ({ confirmations: number | null; err: unknown; confirmationStatus: string; slot: number } | null)[] }>('getSignatureStatuses', [[p.txid], { searchTransactionHistory: true }]);
      const s = r.value[0];
      if (!s) {
        const h = await call<number>('getBlockHeight', [{ commitment: 'finalized' }]);
        if (h > p.intent.sol.lastValidBlockHeight) return { state: 'failed', confirmations: 0, error: 'expired before inclusion (blockhash too old); no funds moved' };
        return { state: 'broadcast', confirmations: 0, rebroadcast: true };
      }
      if (s.err) return { state: 'failed', confirmations: 0, blockRef: String(s.slot), error: `on-chain error: ${JSON.stringify(s.err).slice(0, 120)}` };
      if (s.confirmationStatus === 'finalized') return { state: 'finalized', confirmations: 32, blockRef: String(s.slot) };
      return { state: 'confirming', confirmations: s.confirmations ?? 1, blockRef: String(s.slot) };
    },
    async deposits(addr, cursor) {
      const items: Deposit[] = [];
      const targets = [addr, ...n.tokens.map((t) => associatedTokenAddress(addr, t.id))];
      const sigs = new Map<string, number>();
      for (const t of targets) {
        const r = await call<{ signature: string; slot: number; err: unknown }[]>('getSignaturesForAddress', [t, { limit: 15, commitment: 'finalized' }]);
        for (const s of r) if (!s.err && s.slot > (cursor ?? 0)) sigs.set(s.signature, s.slot);
      }
      let maxSlot = cursor ?? 0;
      for (const [sig, slot] of [...sigs].slice(0, 15)) {
        const tx = await call<any>('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
        if (!tx?.meta) continue;
        const keys: string[] = tx.transaction.message.accountKeys.map((k: any) => k.pubkey ?? k);
        const signer = keys[0] ?? '';
        const me = keys.indexOf(addr);
        if (me >= 0 && signer !== addr) {
          const delta = BigInt(tx.meta.postBalances[me]) - BigInt(tx.meta.preBalances[me]);
          if (delta > 0n) items.push({ txid: sig, idx: 0, asset: 'native', amount: delta, from: signer, block: slot, time: tx.blockTime ?? null });
        }
        for (const t of n.tokens) {
          const f = (arr: any[]) => BigInt(arr?.find((b: any) => b.owner === addr && b.mint === t.id)?.uiTokenAmount.amount ?? '0');
          const delta = f(tx.meta.postTokenBalances) - f(tx.meta.preTokenBalances);
          if (delta > 0n) items.push({ txid: sig, idx: 1, asset: t.id, amount: delta, from: signer === addr ? '' : signer, block: slot, time: tx.blockTime ?? null });
        }
        maxSlot = Math.max(maxSlot, slot);
      }
      return { items, cursor: maxSlot, finalizedHeight: Number.MAX_SAFE_INTEGER };
    },
  };
}

/** Run the exact message through the cluster's simulator before asking for approval. */
export async function simulateSol(n: NetworkDef, intent: Intent): Promise<void> {
  const wire = Buffer.from(solWireTransaction(new Uint8Array(64), buildSolMessage(intent))).toString('base64');
  const r = await rpcAny<{ value: { err: unknown; logs: string[] | null } }>(n.rpc, 'simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  if (r.value.err) throw new UserError('simulation_failed', `simulation failed: ${JSON.stringify(r.value.err).slice(0, 120)} ${(r.value.logs ?? []).slice(-2).join(' | ').slice(0, 200)}`);
}
