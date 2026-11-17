// The SOLANA transfer PREPARATION path (services/api/src/nft/transfer.ts `prepareSol`) in the suite — delivery 2 exercised it
// on the local-validator proof only (docs/nft/work/nft-2.md §8).
//
// Fixture: services/api/test/fixtures/nft/sol-prepare.json — LIVE-RECORDED keyless on Solana mainnet by
// scripts/record-nft-prepare-fixtures.mts: for each standard, the JSON-RPC calls of one preparation of a REAL NFT whose REAL
// holder stands as "the wallet" (no key involved), up to `simulateTransaction` (sigVerify: false) of the exact message.
// Nothing was signed or sent. The replay matches every call on its exact parameters: the message this test builds is
// therefore byte-for-byte the one mainnet simulated when the fixture was recorded.
//
// What is asserted against the shapes the local validator proved (work/nft-2.md §5.3): the program, the instruction data,
// the accounts and their order / roles, the fee, and the review's simulation changes (as codes). Then the refusals: a
// destination that is the wallet, a tampered account in the replayed chain state, a quantity other than one.
// A standard with no recorded case says so (the record script could not find a mainnet NFT of it held by an ordinary wallet).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replay, type RecordedCall } from './nft-helpers.ts';

Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { DEFAULT_POLICY, defaultNftPolicy, planNftSol, buildNftSolMessage, verifyNftSolMessage, associatedTokenAddress, nftMetadataPda, nftEditionPda, nftTokenRecordPda, NFT_CORE_PROGRAM, NFT_TOKEN_METADATA_PROGRAM, NFT_TOKEN_AUTH_RULES_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, SYSTEM_PROGRAM } = await import('@spw/core');
const { solanaProvider } = await import('../src/nft/solana.ts');
const { prepareNftTransfer } = await import('../src/nft/transfer.ts');
const { quorumOver, anyOver } = await import('../src/nft/index.ts');

interface Case { standard: string; address: string; wallet: string; to: string; proposalId: string; now: string; calls: RecordedCall[]; observed: { hash: string; program: string; method: string; computeUnits: string; fee: string; rent: string; toKind: string; accounts: number } }
const fx = JSON.parse(readFileSync(new URL('./fixtures/nft/sol-prepare.json', import.meta.url), 'utf8')) as { recordedAt: string; provenance: string; cases: Case[] };
const caseOf = (standard: string): Case | undefined => fx.cases.find((c) => c.standard === standard);
const status = (wallet: string, o: Record<string, unknown> = {}) => ({ keyId: 'spw-prepare-fixture', addresses: { solana: wallet }, halted: false, enrollmentOpen: false, credentials: [], policy: DEFAULT_POLICY, spentToday: {}, journalHead: null, journalLength: 0,
  nft: { policy: defaultNftPolicy(), signedToday: 0, allow: [] }, utxoLocks: {}, ...o });
async function prepare(c: Case, o: { calls?: RecordedCall[]; to?: string; quantity?: bigint; st?: Record<string, unknown> } = {}) {
  const world = replay({ recordedAt: c.now, note: '', calls: o.calls ?? c.calls }), now = () => new Date(c.now);
  const provider = solanaProvider({ rpc: world.rpc, now, dasUrl: null });
  const a = await provider.lookup('solana', { address: c.address }, c.wallet);
  const prep = await prepareNftTransfer({ quorum: quorumOver(world.rpc), any: anyOver(world.rpc), lookup: (chain, r, w) => provider.lookup(chain, r, w), now }, a, status(c.wallet, o.st) as never, c.wallet, o.to ?? c.to, o.quantity ?? 1n, c.proposalId);
  return { a, prep, asked: world.asked };
}
const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'PREPARED', (e: { code?: string }) => e.code ?? 'error');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('Solana NFT transfer preparation on recorded mainnet accounts', () => {
  it('the fixture is a live recording, and says which standards it holds', () => {
    expect(fx.provenance).toContain('LIVE-RECORDED'); expect(fx.cases.length).toBeGreaterThanOrEqual(1);
    for (const c of fx.cases) { expect(c.calls.some((x) => x.method === 'simulateTransaction' && x.result), c.standard).toBe(true); expect(c.calls.every((x) => /^(api\.mainnet-beta\.solana\.com|solana-rpc\.publicnode\.com)$/.test(x.host)), c.standard).toBe(true); }
    expect(caseOf('metaplex-core'), 'the reference Core asset must be recorded').toBeDefined();
  });

  it('METAPLEX CORE — the reference asset: TransferV1, data [14, 0], 7 accounts in the IDL order; fee and compute as the validator proof found', async () => {
    const c = caseOf('metaplex-core')!, { a, prep } = await prepare(c);
    expect(c.address).toBe('CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j'); expect(a.standard).toBe('metaplex-core'); expect(a.ownership.heldByWallet).toBe(true);
    expect(prep.hash).toBe(c.observed.hash);                                                   // the same canonical intent as when mainnet simulated it
    const i = prep.intent, plan = planNftSol(i), ix = plan.ixs.at(-1)!;
    expect(i).toMatchObject({ kind: 'nft-transfer', standard: 'metaplex-core', asset: c.address, program: NFT_CORE_PROGRAM, from: c.wallet, to: c.to, quantity: '1', sol: { collection: 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC' } });
    expect(i.sol!.tokenProgram).toBeUndefined(); expect(plan.ixs.map((x) => x.program)).toEqual(['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', NFT_CORE_PROGRAM]);
    expect(hex(ix.data)).toBe('0e00');
    expect(ix.accounts.map((m) => [m.pubkey, m.signer, m.writable])).toEqual([[c.address, false, true], ['phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', false, false], [c.wallet, true, true], [c.wallet, true, true], [c.to, false, false], [SYSTEM_PROGRAM, false, false], [NFT_CORE_PROGRAM, false, false]]);
    expect(prep.review.accounts.map((x) => `${x.role}=${x.derived}`)).toEqual(['asset=intent', 'collection=intent', 'payer and authority=derived', 'new owner=intent', 'program=pinned']);
    // the figures of the local-validator proof (work/nft-2.md §5.3): 7 801 compute units, fee 5 101 lamports, no rent
    expect(prep.review.simulation.used).toBe('7801'); expect(prep.review.fee).toMatchObject({ max: '5101', rent: '0', symbol: 'SOL' }); expect(prep.review.toKind).toBe('new_account');
    expect(prep.review.simulation.changes.map((x) => x.code)).toEqual(['sol_core_owner', 'sol_wallet_lamports']); expect(prep.review.simulation.changes[0]).toMatchObject({ before: c.wallet, after: c.to, what: 'owner of the asset' });
    expect(prep.review.warnings).toContain('core_collection_permanent_delegate'); expect(prep.review.verified.ownership).toContain('owner = this wallet, not frozen');
    // the bytes the signer would build pass the signer's own verifier, and are the bytes that were simulated
    const msg = buildNftSolMessage(i); expect(() => verifyNftSolMessage(msg, i)).not.toThrow();
  });

  it('PROGRAMMABLE NFT — Token Metadata Transfer: data [49, 0, amount 1, no authorization data], 17 accounts with token records and the rule set', async () => {
    const c = caseOf('metaplex-pnft');
    if (!c) { console.warn('no programmable-NFT case in sol-prepare.json: not exercised here (the validator proof covers it)'); return; }
    const { a, prep } = await prepare(c), i = prep.intent, plan = planNftSol(i), ix = plan.ixs.at(-1)!;
    expect(a.standard).toBe('metaplex-pnft'); expect(prep.hash).toBe(c.observed.hash); expect(i.program).toBe(NFT_TOKEN_METADATA_PROGRAM); expect(i.sol!.tokenProgram).toBe('token');
    const src = associatedTokenAddress(c.wallet, c.address, TOKEN_PROGRAM), dst = associatedTokenAddress(c.to, c.address, TOKEN_PROGRAM), ruleSet = i.sol!.ruleSet;
    expect(hex(ix.data)).toBe('3100010000000000000000'); expect(ix.accounts).toHaveLength(17);
    expect(ix.accounts.slice(0, 11).map((m) => m.pubkey)).toEqual([src, c.wallet, dst, c.to, c.address, nftMetadataPda(c.address), nftEditionPda(c.address), nftTokenRecordPda(c.address, src), nftTokenRecordPda(c.address, dst), c.wallet, c.wallet]);
    expect(ix.accounts.slice(15).map((m) => m.pubkey)).toEqual(ruleSet ? [NFT_TOKEN_AUTH_RULES_PROGRAM, ruleSet] : [NFT_TOKEN_METADATA_PROGRAM, NFT_TOKEN_METADATA_PROGRAM]);
    expect(ix.accounts.filter((m) => m.signer).map((m) => m.pubkey)).toEqual([c.wallet, c.wallet]);
    expect(prep.review.simulation.changes.map((x) => x.code)).toEqual(['sol_wallet_token_units', 'sol_destination_token_units', 'sol_wallet_lamports']);
    expect(prep.review.simulation.changes[1]).toMatchObject({ beforeCode: 'no_account', after: '1', params: { owner: c.to } }); expect(BigInt(prep.review.fee.rent!)).toBeGreaterThan(0n);
    expect(prep.review.verified.ownership).toBe('token account: owner = this wallet, amount 1; token record: unlocked, no delegate'); if (ruleSet) expect(prep.review.warnings).toContain('pnft_rule_set');
    expect(() => verifyNftSolMessage(buildNftSolMessage(i), i)).not.toThrow();
  });

  it('LEGACY TOKEN METADATA NFT — the same instruction without token records or rule set', async () => {
    const c = caseOf('metaplex-token-metadata');
    if (!c) { console.warn('no legacy Token Metadata case in sol-prepare.json: not exercised here (the validator proof covers it)'); return; }
    const { prep } = await prepare(c), i = prep.intent, ix = planNftSol(i).ixs.at(-1)!;
    const src = associatedTokenAddress(c.wallet, c.address, TOKEN_PROGRAM), dst = associatedTokenAddress(c.to, c.address, TOKEN_PROGRAM);
    expect(prep.hash).toBe(c.observed.hash); expect(i.program).toBe(NFT_TOKEN_METADATA_PROGRAM); expect(i.sol!.ruleSet).toBeUndefined(); expect(hex(ix.data)).toBe('3100010000000000000000');
    expect(ix.accounts.map((m) => m.pubkey).slice(0, 9)).toEqual([src, c.wallet, dst, c.to, c.address, nftMetadataPda(c.address), nftEditionPda(c.address), NFT_TOKEN_METADATA_PROGRAM, NFT_TOKEN_METADATA_PROGRAM]);
    expect(ix.accounts.slice(15).map((m) => m.pubkey)).toEqual([NFT_TOKEN_METADATA_PROGRAM, NFT_TOKEN_METADATA_PROGRAM]);
    expect(prep.review.verified.ownership).toBe('token account: owner = this wallet, amount 1, not frozen, no delegate'); expect(prep.review.simulation.changes.map((x) => x.code)).toEqual(['sol_wallet_token_units', 'sol_destination_token_units', 'sol_wallet_lamports']);
    expect(() => verifyNftSolMessage(buildNftSolMessage(i), i)).not.toThrow();
  });

  it('TOKEN-2022 NFT — CreateIdempotent + TransferChecked [12, amount 1, decimals 0]', async () => {
    const c = caseOf('spl-token-2022');
    if (!c) { console.warn('no Token-2022 case in sol-prepare.json: no mainnet Token-2022 NFT held by an ordinary wallet was found when recording — covered by the local-validator proof only'); return; }
    const { prep } = await prepare(c), i = prep.intent, ixs = planNftSol(i).ixs, ix = ixs.at(-1)!;
    expect(prep.hash).toBe(c.observed.hash); expect(i.program).toBe(TOKEN_2022_PROGRAM); expect(hex(ix.data)).toBe('0c010000000000000000');
    expect(ix.accounts.map((m) => m.pubkey)).toEqual([associatedTokenAddress(c.wallet, c.address, TOKEN_2022_PROGRAM), c.address, associatedTokenAddress(c.to, c.address, TOKEN_2022_PROGRAM), c.wallet]);
  });

  it('refusals on the same recorded state: the wallet as destination, a quantity other than one, a halted signer, an asset the chain no longer gives to the wallet', async () => {
    const c = caseOf('metaplex-core')!;
    expect(await code(prepare(c, { to: c.wallet }))).toBe('nft_transfer_destination_is_wallet');
    expect(await code(prepare(c, { quantity: 2n }))).toBe('nft_transfer_bad_quantity');
    expect(await code(prepare(c, { to: 'not-an-address' }))).toBe('nft_transfer_bad_destination');
    expect(await code(prepare(c, { st: { halted: true } }))).toBe('halted');
    expect(await code(prepare(c, { st: { nft: undefined } }))).toBe('nft_transfer_signer_too_old');
    // the chain state changes between the lookup and the re-verification: ONE endpoint now names another owner (bytes 1..33 of the asset account) → the quorum read refuses
    const tampered = c.calls.map((x) => { if (x.method !== 'getMultipleAccounts' || x.host !== 'solana-rpc.publicnode.com' || !JSON.stringify(x.params).includes('"finalized"')) return x;
      const r = structuredClone(x.result) as { value: ({ data: [string, string] } | null)[] }, raw = Buffer.from(r.value[0]!.data[0], 'base64'); raw[5] = raw[5]! ^ 0xff; r.value[0]!.data[0] = raw.toString('base64'); return { ...x, result: r }; });
    expect(tampered.some((x, k) => x !== c.calls[k])).toBe(true);
    expect(await code(prepare(c, { calls: tampered }))).toMatch(/^(nft_transfer_ownership_single_source|rpc_disagreement)$/); // refused at the first read that sees the two endpoints disagree: nothing is prepared on one endpoint's word
    // a destination that was not the one simulated: the replay has no such simulation — nothing is answered from imagination
    expect(await code(prepare(c, { to: '8KqdDz4P7cNf1kKBspphBGCwVMiarH9TwiXFdpMEYshR' }))).not.toBe('PREPARED');
  });
});
