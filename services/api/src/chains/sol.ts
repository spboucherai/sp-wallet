import { associatedTokenAddress, buildSolMessage, getAsset, solFeeLamports, solWireTransaction, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, tokenProgramOf, type Intent, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { benchOnFailure, FAST, hostOf, notBenched, rpcAny, rpcOne, rpcQuorum, settle, type Adapter, type BalancesDetailed, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

const RENT_ATA = 2_039_280n; // rent-exempt minimum for a 165-byte token account
const RENT_SYSTEM = 890_880n; // rent-exempt minimum for a 0-byte system account
/** NEXT: accounts per getMultipleAccounts of the balance read. 10: one of the two public endpoints refuses more (HTTP 403 "A maximum of 10 accounts is allowed", observed 2026-11-19) */
export const SOL_ATA_CHUNK = 10;
/** NEXT: a balance read at a slot older than this is flagged `stale` */
export const SOL_STALE_SEC = 180;
/** NEXT H3: signatures per page, pages per account and transactions per pass of the deposit scan */
export const SOL_SIG_FIRST = 25, SOL_SIG_PAGE = 1000, SOL_SIG_MAX_PAGES = 50, SOL_TX_PER_PASS = 40;
/** a transaction no endpoint serves any more is given up (and reported) only when it is older than this */
export const SOL_TX_GONE_SEC = 2 * 86_400;

export function solAdapter(n: NetworkDef): Adapter {
  const call = <T>(m: string, p: unknown[]) => rpcAny<T>(n.rpc, m, p);
  let identity = false;
  const acct = (a: string) => call<{ value: { owner: string; lamports: number; data: unknown } | null }>('getAccountInfo', [a, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  type Parsed = { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } };
  /** All token accounts of the owner, both token programs: two calls regardless of how many mints are allowlisted. */
  const tokenAccounts = async (owner: string): Promise<Parsed[]> => {
    const rs = await Promise.all([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
      call<{ value: Parsed[] }>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])));
    return rs.flatMap((r) => r.value);
  };
  const disabled = new Set<string>();
  let tokensChecked = false;
  async function verifyTokens(): Promise<void> { // mint must exist, be owned by the expected token program and have the pinned decimals
    for (let k = 0; k < n.tokens.length; k += 50) {
      const chunk = n.tokens.slice(k, k + 50);
      const r = await call<{ value: ({ owner: string; data: { parsed?: { type: string; info: { decimals: number } } } } | null)[] }>('getMultipleAccounts', [chunk.map((t) => t.id), { encoding: 'jsonParsed', commitment: 'finalized' }]);
      chunk.forEach((t, j) => { const a = r.value[j];
        const good = !!a && a.owner === tokenProgramOf(t) && a.data.parsed?.type === 'mint' && a.data.parsed.info.decimals === t.decimals;
        if (good) disabled.delete(t.id); else { disabled.add(t.id); console.error(`[sol] token ${t.symbol} ${t.id} failed on-chain mint check — disabled`); } });
    }
    tokensChecked = true;
  }
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
      if (identity && !tokensChecked) await verifyTokens().catch(() => {});
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },
    /**
     * NEXT B1: a token is in the answer only when it was READ. A token whose balance could not be established is absent from
     * the map (as on the EVM adapter) — never 0. See `balancesDetailed` for the rule.
     */
    async balances(addr) {
      const d = await this.balancesDetailed!(addr);
      return Object.fromEntries(Object.entries(d.assets).map(([id, r]) => [id, r.amount]));
    },
    /**
     * NEXT B1 / B2 — every endpoint is asked. On each one: the lamports; the associated token account of every registry
     * token, read DIRECTLY (getMultipleAccounts, SOL_ATA_CHUNK accounts per call — the read that says "this account holds X" or "this
     * account does not exist"); and the list of the owner's token accounts of both token programs.
     * The list is what finds token accounts other than the associated one, but it is the weak read: an endpoint may refuse it
     * (observed 2026-11-19: one of the two public endpoints answers HTTP 403 to getTokenAccountsByOwner) or answer it
     * truncated. So, per endpoint and per token:
     *   associated account   the direct read (amount, or "does not exist"); without a direct read, the list's entry if it has one;
     *   other accounts       the list's, counted only when that list agrees with the direct read about the associated account
     *                        (a list that misses an account the direct read sees is truncated: nothing is taken from it).
     * Across endpoints, on the associated account: amounts are compared (equal: agreed; else `agreed: false`, higher slot
     * shown); "exists" on one and "does not exist" on another = unavailable; "does not exist" is 0 only when at least two
     * endpoints say so (or the network has one endpoint) — a single answer of absence is not a positive read. The other
     * accounts of the mint, when a list reports some, are added; they rest on the listing endpoints only (`sources`).
     * Limit, stated: a token held ONLY in a non-associated account that no list reports cannot be seen.
     */
    async balancesDetailed(addr): Promise<BalancesDetailed> {
      const toks = n.tokens.filter((t) => !disabled.has(t.id));
      const atas = toks.map((t) => associatedTokenAddress(addr, t.id, tokenProgramOf(t)));
      type Ctx<T> = { context?: { slot?: number }; value: T };
      const slotOf = (c: Ctx<unknown>): number | null => (typeof c.context?.slot === 'number' ? c.context.slot : null);
      /** one endpoint's view of one token: `ata` = amount | null (the account does not exist) | undefined (not read); `aux` = other accounts of the mint (undefined: no usable list) */
      type TokenView = { ata: bigint | null | undefined; aux: bigint | undefined; slot: number | null };
      const readOn = async (url: string): Promise<{ native: { amount: bigint; height: number | null }; tokens: Map<string, TokenView> } | null> => {
        let native: { amount: bigint; height: number | null };
        try { const b = await rpcOne<Ctx<number>>(url, 'getBalance', [addr, { commitment: 'confirmed' }], FAST); if (!Number.isSafeInteger(b.value) || b.value < 0) return null; native = { amount: BigInt(b.value), height: slotOf(b) }; }
        catch (e) { benchOnFailure(url, e); return null; }
        const tokens = new Map<string, TokenView>();
        if (!toks.length) return { native, tokens };
        const [direct, list] = await Promise.all([
          (async () => { // the associated account of every registry token
            try {
              const out: ({ amount: bigint } | null | undefined)[] = []; let slot: number | null = null, first = true;
              const chunks = Array.from({ length: Math.ceil(atas.length / SOL_ATA_CHUNK) }, (_, k) => atas.slice(k * SOL_ATA_CHUNK, (k + 1) * SOL_ATA_CHUNK));
              const answers = await Promise.all(chunks.map((keys) => rpcOne<Ctx<({ data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } | null)[]>>(url, 'getMultipleAccounts', [keys, { encoding: 'jsonParsed', commitment: 'confirmed' }], FAST)));
              for (const [k, r] of answers.entries()) {
                if (!Array.isArray(r.value) || r.value.length !== chunks[k]!.length) throw new Error('short answer');
                const s = slotOf(r); slot = first ? s : slot === null || s === null ? null : Math.min(slot, s); first = false;
                // an account that exists but is not a parsed token account is not a read of this token
                for (const a of r.value) { const amt = a?.data?.parsed?.info?.tokenAmount?.amount; out.push(a === null ? null : typeof amt === 'string' && /^\d+$/.test(amt) ? { amount: BigInt(amt) } : undefined); }
              }
              return { out, slot };
            } catch { return null; }
          })(),
          (async () => { // every token account of the owner (may be refused)
            try {
              const rs = await Promise.all([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) => rpcOne<Ctx<Parsed[]>>(url, 'getTokenAccountsByOwner', [addr, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }], FAST)));
              if (rs.some((l) => !Array.isArray(l.value))) return null;
              const slots = rs.map(slotOf);
              return { accts: rs.flatMap((l) => l.value), slot: slots.every((x) => x !== null) ? Math.min(...(slots as number[])) : null };
            } catch { return null; }
          })(),
        ]);
        toks.forEach((t, k) => {
          const mine = list ? list.accts.filter((a) => a.account.data.parsed.info.mint === t.id) : [], inList = mine.find((a) => a.pubkey === atas[k]);
          const amt = (a: Parsed) => BigInt(a.account.data.parsed.info.tokenAmount.amount);
          const others = mine.filter((a) => a.pubkey !== atas[k]).reduce((x, a) => x + amt(a), 0n);
          const d = direct ? direct.out[k] : undefined;
          if (d !== undefined) {
            // the list is used for the other accounts only when it says the same thing as the direct read about this one
            const sameAsList = !!list && (d === null ? !inList : !!inList && amt(inList) === d.amount);
            tokens.set(t.id, { ata: d === null ? null : d.amount, aux: sameAsList ? others : undefined, slot: direct!.slot });
          } else if (list) tokens.set(t.id, { ata: inList ? amt(inList) : undefined, aux: inList || others > 0n ? others : undefined, slot: list.slot });
        });
        return { native, tokens };
      };
      const reads = (await Promise.all(notBenched(n.rpc).map(readOn))).filter((r) => r !== null);
      if (!reads.length) throw new Error('no endpoint answered');
      // age of the state: the time of the highest slot read, when the cluster gives it
      let stale = false;
      const top = Math.max(-1, ...reads.map((r) => r.native.height ?? -1));
      if (top >= 0) { try { const bt = await call<number | null>('getBlockTime', [top]); if (typeof bt === 'number') stale = Date.now() / 1000 - bt > SOL_STALE_SEC; } catch { /* age unknown (skipped slot, method refused) */ } }
      const assets: BalancesDetailed['assets'] = { native: settle(reads.map((r) => r.native), n.rpc.length, stale) }, unavailable: Record<string, string> = {};
      const needZero = Math.min(2, n.rpc.length);
      for (const t of toks) {
        const views = reads.map((r) => r.tokens.get(t.id)).filter((v): v is TokenView => v !== undefined);
        const known = views.filter((v) => v.ata !== undefined), exists = known.filter((v) => v.ata !== null), none = known.filter((v) => v.ata === null);
        const auxViews = views.filter((v) => v.aux !== undefined && v.aux > 0n);
        if (!known.length && !auxViews.length) { unavailable[t.id] = views.length ? 'zero_not_confirmed' : 'no_source_answered'; continue; }
        if (exists.length && none.length) { unavailable[t.id] = 'sources_disagree_on_existence'; continue; }
        // other accounts of the mint: what the lists that could be trusted report (they must agree with each other)
        const aux = auxViews.length ? settle(auxViews.map((v) => ({ amount: v.aux!, height: v.slot })), n.rpc.length, stale) : null;
        if (exists.length) {
          const main = settle(exists.map((v) => ({ amount: v.ata as bigint, height: v.slot })), n.rpc.length, stale);
          assets[t.id] = aux ? { ...main, amount: main.amount + aux.amount, sources: Math.min(main.sources, aux.sources), agreed: main.agreed && aux.agreed } : main;
        } else if (aux) assets[t.id] = aux; // held only outside the associated account
        else if (none.length >= needZero) assets[t.id] = settle(none.map((v) => ({ amount: 0n, height: v.slot })), n.rpc.length, stale);
        else unavailable[t.id] = 'zero_not_confirmed';
      }
      return { assets, unavailable };
    },
    disabledAssets: () => [...disabled],
    async prepare(d): Promise<Prepared> {
      if ((await rpcQuorum<string>(n.rpc, 'getGenesisHash', [])) !== n.chainRef) throw new UserError('rpc_degraded', 'cluster identity mismatch; transfer refused', 503);
      const asset = getAsset(n.id, d.asset), warnings: string[] = [];
      if (!tokensChecked) await verifyTokens();
      if (disabled.has(asset.id)) throw new UserError('unsupported_asset', 'this token failed its on-chain identity check and is disabled');
      const tp = tokenProgramOf(asset);
      const dest = (await acct(d.to)).value;
      if (dest && dest.owner !== SYSTEM_PROGRAM) throw new UserError('bad_destination', 'destination is not a regular wallet address (it is a program-owned or token account)');
      const bal = await this.balances(d.from);
      const computeUnitLimit = asset.id === 'native' ? 5_000 : asset.program === 'token2022' ? 120_000 : 80_000;
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
        if (bal[asset.id] === undefined) throw new UserError('rpc_degraded', 'token balance could not be read; transfer refused', 503); // NEXT B1: unknown is not zero
        if (bal[asset.id]! < d.amount) throw new UserError('insufficient_funds', `insufficient ${asset.symbol} balance`);
        const srcAtaAddr = associatedTokenAddress(d.from, asset.id, tp);
        const srcAta = (await acct(srcAtaAddr)).value;
        // the builder spends from the associated token account only: its own balance must cover the amount
        const inAta = (await tokenAccounts(d.from)).find((a) => a.pubkey === srcAtaAddr);
        if (srcAta && BigInt(inAta?.account.data.parsed.info.tokenAmount.amount ?? '0') < d.amount) throw new UserError('insufficient_funds', `insufficient ${asset.symbol} in the associated token account`);
        if (!srcAta) throw new UserError('insufficient_funds', `no ${asset.symbol} token account in this wallet`);
        createAta = !(await acct(associatedTokenAddress(d.to, asset.id, tp))).value;
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
    /**
     * NEXT H3 — no signature is skipped. The finalized slot is read first and bounds the pass (`upTo`): every account is then
     * listed from an endpoint that is at least at that slot, so a signature finalized while the accounts are being read cannot
     * fall between two reads. Each account (the owner, and its token accounts of registry mints) is paged with `before` until
     * the previous cursor is reached. The transactions are processed OLDEST FIRST, at most SOL_TX_PER_PASS per pass (a slot is
     * never split), and the cursor is the last slot fully processed: a backlog is caught up over several passes.
     * A history deeper than SOL_SIG_MAX_PAGES pages stops the pass with an error rather than moving the cursor. A transaction
     * no endpoint serves stops the pass there, unless it is older than SOL_TX_GONE_SEC: it is then listed in `gaps`.
     */
    async deposits(addr, cursor) {
      const items: Deposit[] = [], gaps: { txid: string; block: number }[] = [];
      const upTo = await call<number>('getSlot', [{ commitment: 'finalized' }]);
      const cur = cursor ?? 0;
      // owner account + only the token accounts that actually exist
      const mine = new Set(n.tokens.filter((t) => !disabled.has(t.id)).map((t) => t.id));
      const targets = [addr, ...(await tokenAccounts(addr)).filter((a) => mine.has(a.account.data.parsed.info.mint)).map((a) => a.pubkey)].slice(0, 40);
      type Sig = { signature: string; slot: number; err: unknown; blockTime?: number | null };
      const sigs = new Map<string, Sig>();
      // -32016 = the backend that answered has not reached `minContextSlot` yet (seen on a load-balanced public endpoint for its own
      // finalized slot): asked again a moment later, twice at most; it is never asked without the bound
      const sigPage = async (t: string, o: Record<string, unknown>): Promise<Sig[]> => {
        for (let k = 0; ; k++) { try { return await call<Sig[]>('getSignaturesForAddress', [t, o]); } catch (e) { if ((e as { rpcCode?: number }).rpcCode !== -32016 || k >= 2) throw e; await new Promise((r) => setTimeout(r, 400)); } }
      };
      for (const t of targets) {
        let before: string | undefined;
        for (let page = 0; ; page++) {
          if (page >= SOL_SIG_MAX_PAGES) throw new Error(`signature history of ${t.slice(0, 8)} deeper than the scan bound; cursor not moved`);
          const limit = page === 0 ? SOL_SIG_FIRST : SOL_SIG_PAGE;
          const r = await sigPage(t, { limit, commitment: 'finalized', minContextSlot: upTo, ...(before ? { before } : {}) });
          let reached = false;
          for (const x of r) { if (x.slot <= cur) { reached = true; break; } if (x.slot <= upTo) sigs.set(x.signature, x); }
          // the first pass of a wallet (no cursor) reads the newest page only: there is no "previous cursor" to reach
          if (reached || r.length < limit || cursor === null) break;
          before = r[r.length - 1]!.signature;
        }
      }
      const todo = [...sigs.values()].sort((a, b) => a.slot - b.slot || (a.signature < b.signature ? -1 : 1));
      const getTx = async (sig: string): Promise<any> => { // null from one endpoint is not "does not exist": every endpoint is asked
        let answered = false, last: unknown;
        for (const u of n.rpc) { try { const tx = await rpcOne<any>(u, 'getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]).catch((e) => { if (/empty result/.test(String((e as Error).message))) return null; throw e; }); answered = true; if (tx?.meta) return tx; } catch (e) { last = e; } }
        if (!answered) throw last;
        return null;
      };
      let done = cur, k = 0, calls = 0;
      for (; k < todo.length; k++) {
        const s = todo[k]!;
        if (calls >= SOL_TX_PER_PASS && s.slot !== todo[k - 1]?.slot) break;
        if (s.err) { done = s.slot; continue; } // a failed transaction moved nothing
        calls += 1;
        const tx = await getTx(s.signature);
        if (!tx) {
          if (typeof s.blockTime === 'number' && Date.now() / 1000 - s.blockTime > SOL_TX_GONE_SEC) { gaps.push({ txid: s.signature, block: s.slot }); done = s.slot; continue; }
          break;
        }
        const keys: string[] = tx.transaction.message.accountKeys.map((x: any) => x.pubkey ?? x);
        const signer = keys[0] ?? '';
        const me = keys.indexOf(addr);
        if (me >= 0 && signer !== addr) {
          const delta = BigInt(tx.meta.postBalances[me]) - BigInt(tx.meta.preBalances[me]);
          if (delta > 0n) items.push({ txid: s.signature, idx: 0, asset: 'native', amount: delta, from: signer, block: s.slot, time: tx.blockTime ?? null });
        }
        for (const t of n.tokens) {
          if (disabled.has(t.id)) continue;
          const f = (arr: any[]) => BigInt(arr?.find((b: any) => b.owner === addr && b.mint === t.id)?.uiTokenAmount.amount ?? '0');
          const delta = f(tx.meta.postTokenBalances) - f(tx.meta.preTokenBalances);
          if (delta > 0n) items.push({ txid: s.signature, idx: 1 + n.tokens.indexOf(t), asset: t.id, amount: delta, from: signer === addr ? '' : signer, block: s.slot, time: tx.blockTime ?? null });
        }
        done = s.slot;
      }
      // stopped before the end: the slot of the first unprocessed signature is not complete, the cursor stays just before it
      const next = k < todo.length ? Math.max(cur, Math.min(done, todo[k]!.slot - 1)) : done;
      return { items: items.filter((d) => d.block <= next), cursor: next, finalizedHeight: Number.MAX_SAFE_INTEGER, ...(gaps.length ? { gaps: gaps.filter((g) => g.block <= next) } : {}) };
    },
  };
}

/** Run the exact message through the cluster's simulator before asking for approval. */
export async function simulateSol(n: NetworkDef, intent: Intent): Promise<void> {
  const wire = Buffer.from(solWireTransaction(new Uint8Array(64), buildSolMessage(intent))).toString('base64');
  const r = await rpcAny<{ value: { err: unknown; logs: string[] | null } }>(n.rpc, 'simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  if (r.value.err) throw new UserError('simulation_failed', `simulation failed: ${JSON.stringify(r.value.err).slice(0, 120)} ${(r.value.logs ?? []).slice(-2).join(' | ').slice(0, 200)}`);
}
