// NFT providers on RECORDED live answers (services/api/test/fixtures/nft, scripts/record-nft-fixtures.mts, recorded 2026-11-17
// from the wallet's public endpoints — provenance in each fixture's `note`). No network, no database. What the tests assert is
// what the chain (or the indexer) really said that day for public assets: nothing here is invented, and an unrecorded call throws.
//   Solana: the brief's reference item (a Metaplex Core asset), a legacy Token Metadata NFT in a marketplace escrow, a pNFT
//   (locked, delegated, rule set), a Token-2022 NFT, a compressed NFT, a burned one, a whole public inventory (token + Core +
//   compressed sections, frozen and delegated items), and things that are not NFTs.
//   EVM: ERC-721, ERC-721 without metadata, a pre-standard contract, a non-standard one, an ERC-20, ERC-1155 quantity 1, >1 and 0,
//   transfer logs of a token; an indexer whose list is only a hint.
import { describe, expect, it } from 'vitest';
import { decodeCoreAsset, decodeCoreCollection, decodeTmMetadata, editionPda, metadataPda, NftProviderError, tokenRecordPda, type NftAsset } from '@spw/nft';
import { clockOf, loadFixture, replay } from './nft-helpers.ts';

Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { solanaProvider } = await import('../src/nft/solana.ts');
const { evmProvider } = await import('../src/nft/evm.ts');
const { magicEdenMarket, externalMarketLinks } = await import('../src/nft/market.ts');

const REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j';
const sol = (name: string, dasUrl: string | null | 'off' = null) => { const fx = loadFixture(name), r = replay(fx); return { fx, r, p: solanaProvider({ rpc: r.rpc, now: clockOf(fx), dasUrl }) }; };
const code = async (f: Promise<unknown>): Promise<string> => f.then(() => 'no error', (e) => (e instanceof NftProviderError ? `${e.code}${e.message.includes('(') ? `:${e.message.split('(')[1]!.replace(')', '')}` : ''}` : `other:${(e as Error).message}`));
const val = <T,>(k: { state: string; value?: T }): T | string => (k.state === 'known' ? (k.value as T) : k.state);

describe('Solana — the reference item CMhG…659j (Metaplex Core)', () => {
  it('is a Core asset: everything shown is what the two endpoints returned for its account', async () => {
    const { p } = sol('sol-core-reference'), a = await p.lookup('solana', { address: REF }, null);
    expect(a.key).toBe(`sol:solana:${REF}`); expect(a.standard).toBe('metaplex-core'); expect(a.tokenProgram).toBe('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
    expect(a.metadata.onchainName).toBe('2016 Pokemon XY Special Box Prom'); expect(a.metadata.sourceUri).toBe(`https://metadata.phygitals.com/${REF}`);
    expect(a.metadata.status).toBe('not_loaded'); expect(a.metadata.name).toBeNull(); expect(a.metadata.attributes).toEqual([]); // creator metadata is not the provider's business
    expect(val(a.ownership.owner)).toBe('62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS'); expect(a.ownership.heldByWallet).toBe(false); expect(a.ownership.state).toBe('not_in_wallet');
    expect(a.ownership.source).toMatchObject({ category: 'onchain', source: 'solana-rpc', confidence: 'chain_verified', detail: 'api.mainnet-beta.solana.com, solana-rpc.publicnode.com' }); expect(a.ownership.source.blockRef?.slot).toMatch(/^[0-9]+$/);
    expect(a.collection).toMatchObject({ id: 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', key: 'sol:solana:phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', name: 'Phygitals', verifiedOnChain: { state: 'known', value: true } });
    expect(val(a.updateAuthority)).toBe('6gn64NNTDS4sNDfAq6Qk6cdgPeCWjupPbUVLfNSHeY4S'); // the collection's update authority, read from the collection account
    expect(val(a.metadata.mutable)).toBe(true); expect(val(a.ownership.frozen)).toBe(false); expect(a.ownership.delegate.state).toBe('none');
    // the collection carries permanent delegates: the collection's authority can move or burn any item — shown, not hidden
    expect(a.extensions).toEqual(['core-collection:PermanentFreezeDelegate', 'core-collection:PermanentTransferDelegate', 'core-collection:PermanentBurnDelegate']);
    expect(a.creators.state).toBe('unsupported'); expect(a.ownership.tokenAccount.state).toBe('unsupported'); expect(a.market).toBeNull();
    expect(a.capabilities).toMatchObject({ transferable: false, transferBlockedBy: ['not_in_wallet', 'transfer_not_built'], marketActions: false });
    expect(a.quantity).toBe('1'); expect(typeof a.quantity).toBe('string');
  });
  it('held by the wallet when the wallet IS the on-chain owner — and only then', async () => {
    const { p } = sol('sol-core-reference');
    const mine = await p.lookup('solana', { address: REF }, '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS');
    expect(mine.ownership).toMatchObject({ heldByWallet: true, state: 'in_wallet' }); expect(mine.capabilities.transferBlockedBy).toEqual(['transfer_not_built']); expect(mine.ownerAddress).toBe('62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS');
  });
  it('its collection account and its history, decoded from Core instructions', async () => {
    const { p } = sol('sol-core-reference'), a = await p.lookup('solana', { address: REF }, null);
    const c = await p.collection('solana', a.collection!.id);
    expect(c).toMatchObject({ standard: 'metaplex-core', onchainName: 'Phygitals', updateAuthority: { state: 'known', value: '6gn64NNTDS4sNDfAq6Qk6cdgPeCWjupPbUVLfNSHeY4S' } }); expect(c.size.state).toBe('known'); expect(c.uri).toMatch(/^https:\/\//);
    const e = await p.events(a, null);
    expect(e.completeness).toBe('full'); expect(e.events.length).toBe(8);
    expect(e.events[0]).toMatchObject({ type: 'transfer', to: '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS', from: null, quantity: '1', price: null, finality: 'finalized', at: '2026-11-10T16:40:35.000Z', tx: '3jtZVMPVXKWjQzXAu9Q64VS4vcvfVQQwVfF1wfev52yPSfjRPBTnEF7eiQUY8fyZ8gDvoJ2rP9ZSyEtoLA6j1nAc' });
    expect(new Set(e.events.map((x) => x.id)).size).toBe(e.events.length); // stable, unique ids: <key>|<signature>|<instruction index>
    expect(e.events.every((x) => x.price === null && x.type !== 'sale')).toBe(true); // a transfer is never read as a sale
    expect(e.events.some((x) => x.type === 'unknown')).toBe(true); // an operation that is not understood is kept as such
    expect(e.cursor).toBe(e.events[e.events.length - 1]!.tx);
  });
  it('decoders agree with the raw account bytes', () => {
    const fx = loadFixture('sol-core-reference'), acct = (id: string) => { const c = fx.calls.find((x) => x.method === 'getMultipleAccounts' && JSON.stringify(x.params).includes(`["${id}"`))!; return new Uint8Array(Buffer.from((c.result as { value: { data: [string] }[] }).value[0]!.data[0], 'base64')); };
    const a = decodeCoreAsset(acct(REF));
    expect(a).toMatchObject({ owner: '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS', updateAuthority: { type: 'Collection', address: 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC' }, name: '2016 Pokemon XY Special Box Prom', seq: null, plugins: { plugins: [], complete: true } });
    const c = decodeCoreCollection(acct('phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC'));
    expect(c.plugins.plugins.map((x) => [x.type, x.authority.type, x.frozen])).toEqual([['PermanentFreezeDelegate', 'UpdateAuthority', false], ['PermanentTransferDelegate', 'UpdateAuthority', undefined], ['PermanentBurnDelegate', 'UpdateAuthority', undefined]]);
    expect(() => decodeCoreAsset(acct('phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC'))).toThrow(); expect(() => decodeTmMetadata(acct(REF))).toThrow();
  });
});

describe('Solana — Token Metadata standards', () => {
  it('legacy NFT listed on a marketplace: the chain names the ESCROW as holder; the indexer-reported owner is labelled indexed', async () => {
    const { p, fx } = sol('sol-legacy-escrow'), id = 'J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo', a = await p.lookup('solana', { address: id }, null);
    expect(a.standard).toBe('metaplex-token-metadata'); expect(a.metadata.onchainName).toBe('THUG #1876'); expect(a.metadata.onchainSymbol).toBe('THUG'); expect(a.metadata.sourceUri).toBe('https://arweave.net/OfmcoOylvHPEhI29SEMfF1-8aulg0Qe7oXQVA8yGkRA');
    expect(a.collection).toMatchObject({ id: '5KwhyPToqeGQYmRQjnx3EDSRMnaiCJDMEH3aGT8R3HNc', verifiedOnChain: { state: 'known', value: true }, name: null }); // the collection's NAME is not copied from the item
    expect(val(a.creators)).toEqual([{ address: '8d8CYjuy79LUtUow8UeToUs4Xo35LokYRkeukhJ6uriA', verified: true, share: 0 }, { address: '4td5cAuEmpD8U1icAbXpCZpmEKJjAPjMzEgkbL225FxY', verified: false, share: 100 }]);
    expect(val(a.royaltyBps)).toBe(500); expect(val(a.supply)).toBe('1'); expect(a.ruleSet.state).toBe('unsupported'); expect(a.extensions).toContain('masterEdition:0/0');
    // getTokenLargestAccounts was refused that day; the escrow's token account is not an associated account → the owner comes from DAS, and says so
    expect(fx.calls.some((c) => c.method === 'getTokenLargestAccounts' && c.error)).toBe(true);
    expect(val(a.ownership.owner)).toBe('1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix'); expect(a.ownership.source).toMatchObject({ category: 'indexed', source: 'solana-das', confidence: 'indexer_reported' });
    expect(a.ownership.tokenAccount.state).toBe('unknown'); expect(a.ownership.frozen.state).toBe('unknown'); // not read → not claimed
    expect(a.sources.map((s) => s.category)).toEqual(['onchain', 'indexed']);
    const e = await p.events(a, null);
    expect(e.completeness).toBe('partial'); expect(e.note).toBe('history_from_mint_and_current_token_account');
    expect(e.events.map((x) => [x.type, x.from, x.to])).toEqual([['transfer', 'EuVNEdz5yHiR9kY8KZHPbYfFzX9nS4CFQPmAdPngyH9P', '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix'], ['transfer', '58oPotTcQn6JGuw7VEAPNzJGaywu1KkRWnxr38eQX6iV', 'EuVNEdz5yHiR9kY8KZHPbYfFzX9nS4CFQPmAdPngyH9P'], ['transfer', '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix', '58oPotTcQn6JGuw7VEAPNzJGaywu1KkRWnxr38eQX6iV']]);
    expect(e.events.every((x) => x.price === null)).toBe(true); // a purchase happened here, on a marketplace — and it is still shown as transfers only
  });
  it('pNFT: token standard, rule set, token record state, frozen token account, delegate — all read on-chain', async () => {
    const { p } = sol('sol-pnft'), id = '5FHwu2v4e3M9yUpB2VcJtdDGAngEkWJnoH4VbU4Amm2t', owner = '68KUHsNdR8er6DtWkWneEbJWoDme2MWLoHcwLawJ7gt';
    const a = await p.lookup('solana', { address: id }, null);
    expect(a.standard).toBe('metaplex-pnft'); expect(val(a.ruleSet)).toBe('ARdHQ5FBBMyMaA5dzyJji6U8i7uwAK2TBsMHM8GTBUGn'); expect(val(a.metadata.mutable)).toBe(false);
    expect(a.ownership).toMatchObject({ owner: { state: 'known', value: owner }, tokenAccount: { state: 'known', value: '2vK6qEqvadYp151cBaMnxviSnargTwqcr6F3NgaJD9bg' }, frozen: { state: 'known', value: true }, delegate: { state: 'known', value: '94PEhc7PwL5fjpz7dQoienNWzyBTnupBWksEAjHxd5d9' }, tokenRecordState: { state: 'known', value: 'locked' } });
    expect(a.ownership.source).toMatchObject({ category: 'onchain', confidence: 'chain_verified' }); // the indexer's owner was only a hint: the token account was then read on-chain
    expect(a.capabilities.transferBlockedBy).toEqual(['not_in_wallet', 'pnft_locked', 'pnft_rule_set', 'transfer_not_built']); // never "frozen" for a pNFT: its account is always frozen
    const held = await p.lookup('solana', { address: id }, owner);
    expect(held.ownership).toMatchObject({ heldByWallet: true, state: 'escrow_or_delegated' }); expect(held.capabilities.transferBlockedBy).toEqual(['pnft_locked', 'pnft_rule_set', 'transfer_not_built']);
  });
  it('Token-2022 NFT: program, extensions and the metadata extension', async () => {
    const { p } = sol('sol-token2022'), a = await p.lookup('solana', { address: '1RwLsj9guunjNRQV8fDq1a8S3keE2XgMFmHRUaS2mHM' }, null);
    expect(a.standard).toBe('spl-token-2022'); expect(a.tokenProgram).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'); expect(a.extensions).toEqual(['metadataPointer', 'groupMemberPointer', 'tokenMetadata']);
    expect(a.metadata.onchainName).toBe('ONLYFINS'); expect(a.metadata.sourceUri).toBe('https://bafybeigetp7ywldrr3xxjlc4h7vrairauzm5oeibkychllu3k66nq7lsbq.ipfs.dweb.link');
    expect(a.creators.state).toBe('unsupported'); expect(a.royaltyBps.state).toBe('unsupported'); expect(a.collection).toBeNull(); // a group member pointer is not decoded: no collection is claimed
    expect(a.ownership).toMatchObject({ frozen: { state: 'known', value: false }, delegate: { state: 'none' } }); expect(a.capabilities.transferBlockedBy).toEqual(['not_in_wallet', 'transfer_not_built']);
  });
  it('compressed NFT: no account on-chain — indexed data only, labelled as such; nothing is "chain verified"', async () => {
    const { p } = sol('sol-compressed'), a = await p.lookup('solana', { address: '12XAbDPsEUwVbsN3BZwgdc1uqkTanp7Tds9mEtNEuTH' }, null);
    expect(a.standard).toBe('metaplex-bubblegum'); expect(a.mintAddress).toBeNull(); expect(a.sources.every((s) => s.category === 'indexed' && s.confidence === 'indexer_reported')).toBe(true);
    expect(a.collection?.verifiedOnChain.state).toBe('unknown'); expect(a.metadata.traitStatistics).toEqual({ computed: false, reason: 'compressed' });
    expect(a.extensions).toEqual(['tree:hAsrSYBkzdaz4r3EJ6pwxNL1YbGbM5c1jNuhLV6Uzqi', 'leaf:913729']); expect(a.capabilities.transferBlockedBy).toContain('compressed_requires_indexer');
    expect((await p.events(a, null))).toMatchObject({ events: [], completeness: 'unavailable', note: 'compressed_history_requires_indexer' });
  });
  it('without a DAS endpoint a compressed id is simply not found — never an invented asset', async () => {
    const { p } = sol('sol-compressed', 'off');
    expect(await code(p.lookup('solana', { address: '12XAbDPsEUwVbsN3BZwgdc1uqkTanp7Tds9mEtNEuTH' }, null))).toMatch(/^not_found/);
  });
  it('burned: quantity 0, state burned, no owner', async () => {
    const { p } = sol('sol-burned'), a = await p.lookup('solana', { address: '1AvLxeY76HV3P2Fm8XeZGAkgdBkq4C2TGgQUFnjomBj' }, null);
    expect(a.ownership.state).toBe('burned'); expect(a.quantity).toBe('0'); expect(val(a.supply)).toBe('0'); expect(a.capabilities.transferBlockedBy[0]).toBe('burned');
  });
  it('what is not an NFT is refused with a code: fungible mint, wallet address, Core collection, garbage', async () => {
    const { p } = sol('sol-negative');
    expect(await code(p.lookup('solana', { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, null))).toBe('unsupported_standard:fungible_token');
    expect(await code(p.lookup('solana', { address: '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS' }, null))).toBe('unsupported_standard:wallet_address');
    expect(await code(p.lookup('solana', { address: 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC' }, null))).toBe('bad_identifier:core_collection');
    for (const bad of ['', 'not-base58-0OIl', '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', 'abc']) expect(await code(p.lookup('solana', { address: bad }, null))).toMatch(/^bad_identifier/);
  });
  it('PDAs are derived as the programs do (checked against the accounts the fixtures really contain)', () => {
    const fx = loadFixture('sol-pnft'), asked = JSON.stringify(fx.calls.map((c) => c.params)), mint = '5FHwu2v4e3M9yUpB2VcJtdDGAngEkWJnoH4VbU4Amm2t';
    for (const pda of [metadataPda(mint), editionPda(mint), tokenRecordPda(mint, '2vK6qEqvadYp151cBaMnxviSnargTwqcr6F3NgaJD9bg')]) expect(asked).toContain(pda);
  });
});

describe('Solana — inventory of a public address, section by section', () => {
  const OWNER = '68KUHsNdR8er6DtWkWneEbJWoDme2MWLoHcwLawJ7gt';
  it('token accounts + Core assets (on-chain) + compressed (indexed); each asset says where it comes from', async () => {
    const { p, r } = sol('sol-inventory'), inv = await p.inventory('solana', OWNER, { manual: [], max: 40 });
    expect(inv.sections).toEqual([
      { section: 'token', status: 'ok', code: null, unlockedBy: null, source: 'solana-rpc', count: 40, truncated: true }, // the cap is reported, never silent
      { section: 'core', status: 'ok', code: null, unlockedBy: null, source: 'solana-rpc', count: 14, truncated: false },
      { section: 'compressed', status: 'ok', code: null, unlockedBy: null, source: 'solana-das (api.mainnet-beta.solana.com)', count: 9, truncated: false }]);
    const by = (s: string) => inv.assets.filter((a) => a.standard === s);
    expect([by('metaplex-pnft').length, by('metaplex-token-metadata').length, by('metaplex-core').length, by('metaplex-bubblegum').length]).toEqual([22, 18, 14, 9]);
    expect(inv.assets.every((a) => a.ownership.heldByWallet && a.ownerAddress === OWNER && a.origin === 'discovered')).toBe(true);
    expect(new Set(inv.assets.map((a) => a.key)).size).toBe(inv.assets.length);
    expect(by('metaplex-bubblegum').every((a) => a.ownership.source.category === 'indexed')).toBe(true); expect(by('metaplex-core').every((a) => a.ownership.source.category === 'onchain')).toBe(true);
    // frozen and delegated legacy NFTs (staked) and locked pNFTs, as the chain says
    const fox = inv.assets.find((a) => a.assetId === 'GifSyQwxoAJfWF3yfxC6s5654oZUG3gbMAur4yTMs2WG')!;
    expect(fox.metadata.onchainName).toBe('Fox #3635'); expect(val(fox.ownership.frozen)).toBe(true); expect(fox.ownership.delegate.state).toBe('known'); expect(fox.capabilities.transferBlockedBy).toEqual(['frozen', 'delegated', 'transfer_not_built']);
    expect(by('metaplex-pnft').every((a) => val(a.ownership.tokenRecordState) === 'locked' && a.capabilities.transferBlockedBy[0] === 'pnft_locked')).toBe(true);
    // cost: a handful of batched reads, whatever the number of NFTs
    expect(r.asked.length).toBeLessThanOrEqual(20);
  });
  it('a refused section is "blocked by provider" with what unlocks it — the other sections are intact', async () => {
    const fx = loadFixture('sol-inventory');
    const blocked = { ...fx, calls: fx.calls.map((c) => (c.method === 'getProgramAccounts' ? { ...c, result: undefined, error: { code: -32602, message: 'Indexed requests require a personal token. Get one at: https://www.allnodes.com/publicnode' } } : c.method === 'searchAssets' ? { ...c, result: undefined, error: { code: -32601, message: 'Method not found' } } : c)) };
    // the second endpoint refuses both as well (as solana-rpc.publicnode.com really does: recorded in sol-legacy-escrow / the audit)
    for (const c of [...blocked.calls]) if ((c.method === 'getProgramAccounts' || c.method === 'searchAssets') && c.host === 'api.mainnet-beta.solana.com') blocked.calls.push({ ...c, host: 'solana-rpc.publicnode.com', error: c.method === 'searchAssets' ? { code: -32601, message: 'Method not found' } : c.error });
    const r = replay(blocked), p = solanaProvider({ rpc: r.rpc, now: clockOf(fx), dasUrl: null });
    const inv = await p.inventory('solana', OWNER, { manual: [], max: 40 });
    expect(inv.sections.map((s) => [s.section, s.status, s.code, s.unlockedBy])).toEqual([['token', 'ok', null, null], ['core', 'blocked_by_provider', 'provider_method_unsupported', 'SPW_RPC_EXTRA'], ['compressed', 'blocked_by_provider', 'provider_method_unsupported', 'NFT_SOLANA_DAS_URL']]);
    expect(inv.assets.length).toBe(40); expect(inv.assets.every((a) => a.standard === 'metaplex-pnft' || a.standard === 'metaplex-token-metadata')).toBe(true);
  });
  it('every endpoint down: every section is an error — an empty inventory is never presented as "no NFT"', async () => {
    const p = solanaProvider({ rpc: async () => { throw new Error('fetch failed'); }, now: () => new Date(), dasUrl: null });
    const inv = await p.inventory('solana', OWNER, { manual: [], max: 40 });
    expect(inv.assets).toEqual([]); expect(inv.sections.map((s) => s.status)).toEqual(['error', 'error', 'error']); expect(inv.sections.every((s) => s.code === 'provider_unavailable')).toBe(true);
  });
  it('contradictory endpoints: the newest slot is used and the value is no longer "chain verified"', async () => {
    const fx = loadFixture('sol-core-reference');
    const calls = fx.calls.map((c) => { if (c.host !== 'solana-rpc.publicnode.com' || c.method !== 'getMultipleAccounts' || !JSON.stringify(c.params).startsWith(`[["${REF}"]`)) return c;
      const res = structuredClone(c.result) as { context: { slot: number }; value: { data: [string, string] }[] }; const b = Buffer.from(res.value[0]!.data[0], 'base64'); b[5] = b[5]! ^ 0xff; res.value[0]!.data[0] = b.toString('base64'); res.context.slot -= 1000; return { ...c, result: res }; });
    const p = solanaProvider({ rpc: replay({ ...fx, calls }).rpc, now: clockOf(fx), dasUrl: null }), a = await p.lookup('solana', { address: REF }, null);
    expect(val(a.ownership.owner)).toBe('62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS'); expect(a.ownership.source.confidence).toBe('chain_single_source'); expect(a.ownership.source.detail).toContain('endpoints differ');
  });
});

describe('EVM — ERC-721 / ERC-1155 reads on Ethereum mainnet', () => {
  const evm = (name = 'evm-lookups', indexers: Record<string, string> = {}, http: typeof fetch = (async () => { throw new Error('no http in this test'); }) as never) => { const fx = loadFixture(name), r = replay(fx); return { fx, r, p: evmProvider({ rpc: r.rpc, now: clockOf(fx), indexers, http }) }; };
  it('ERC-721: owner, tokenURI, contract name — agreed by both endpoints', async () => {
    const { p } = evm(), a = await p.lookup('ethereum', { address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '1' }, null);
    expect(a).toMatchObject({ key: 'evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1', standard: 'erc721', tokenId: '1', contractAddress: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', quantity: '1' });
    expect(val(a.ownership.owner)).toBe('0x46EFbAedc92067E6d60E84ED6395099723252496'); expect(a.ownership.source).toMatchObject({ confidence: 'chain_verified', detail: 'ethereum-rpc.publicnode.com, eth.drpc.org' });
    expect(a.metadata.sourceUri).toBe('ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1'); expect(a.metadata.onchainSymbol).toBe('BAYC');
    expect(a.collection).toMatchObject({ name: 'BoredApeYachtClub', verifiedOnChain: { state: 'unsupported' } }); // a contract's name() is not a verification, and none is shown
    expect(a.capabilities.transferBlockedBy).toEqual(['not_in_wallet', 'transfer_not_built']);
    const mine = await p.lookup('ethereum', { address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', tokenId: '0x1' }, '0x46efbaedc92067e6d60e84ed6395099723252496'); // other spellings of the same token and owner
    expect(mine.key).toBe(a.key); expect(mine.ownership).toMatchObject({ heldByWallet: true, state: 'in_wallet' }); expect(mine.capabilities.transferBlockedBy).toEqual(['transfer_not_built']);
  });
  it('ERC-721 without the metadata extension: no URI → no name, no image, nothing made up', async () => {
    const { p } = evm(), id = '79233663829379634837589865448569342784712482819484549289560981379859480642508';
    const a = await p.lookup('ethereum', { address: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', tokenId: id }, null);
    expect(a.standard).toBe('erc721'); expect(a.tokenId).toBe(id); expect(a.metadata).toMatchObject({ status: 'no_uri', sourceUri: null, name: null, onchainName: null }); expect(val(a.ownership.owner)).toBe('0x220866B1A2219f40e72f5c628B65D54268cA3A9D');
  });
  it('pre-standard contract (answers ownerOf, does not declare ERC-721) → evm-nonstandard; a contract with no ownerOf, or an ERC-20 → refused', async () => {
    const { p } = evm(), k = await p.lookup('ethereum', { address: '0x06012c8cf97BEaD5deAe237070F9587f8E7A266d', tokenId: '1' }, null);
    expect(k.standard).toBe('evm-nonstandard'); expect(k.capabilities.transferBlockedBy).toEqual(['not_in_wallet', 'unsupported_standard', 'transfer_not_built']);
    expect(await code(p.lookup('ethereum', { address: '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB', tokenId: '1' }, null))).toBe('unsupported_standard:not_erc721_or_erc1155');
    expect(await code(p.lookup('ethereum', { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', tokenId: '1' }, null))).toBe('unsupported_standard:not_erc721_or_erc1155');
  });
  it('ERC-1155: quantity 1, quantity > 1 and quantity 0 are three different answers; there is no single "owner"', async () => {
    const { p } = evm(), c = '0x0905b2277df5c7dd6c5e3399ece8a36621aebe85';
    const one = await p.lookup('ethereum', { address: '0x495f947276749Ce646f68AC8c248420045cb7b5e', tokenId: '81678603736433480652309471562595884520144065466341654349472628651124869562369' }, '0x62e3a8216Abdbd2e4a84Be700905F4BA02FD8A4E');
    expect(one).toMatchObject({ standard: 'erc1155', quantity: '1' }); expect(one.ownership).toMatchObject({ owner: { state: 'unsupported' }, heldByWallet: true, state: 'in_wallet' });
    const many = await p.lookup('ethereum', { address: c, tokenId: '5' }, '0xf17017dD78887f7A6d03a81E36FfBdF67eac2B8a');
    expect(many.quantity).toBe('3'); expect(many.ownership.heldByWallet).toBe(true); expect(many.metadata.sourceUri).toMatch(/^https:\/\/arweave\.net\//);
    const none = await p.lookup('ethereum', { address: c, tokenId: '5' }, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(none.quantity).toBe('0'); expect(none.ownership).toMatchObject({ heldByWallet: false, state: 'not_in_wallet' }); expect(none.key).toBe(many.key); // the same asset, another holder
  });
  it('identifiers are validated before any call', async () => {
    const { p, r } = evm();
    for (const [address, tokenId] of [['0x123', '1'], ['BC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', '1'], ['0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', undefined], ['0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', '-1'], ['0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', '1.5'], ['0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', (1n << 256n).toString()]] as const)
      expect(await code(p.lookup('ethereum', { address, tokenId }, null))).toMatch(/^bad_identifier/);
    expect(await code(p.lookup('solana', { address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '1' }, null))).toMatch(/^unsupported_chain/);
    expect(r.asked.length).toBe(0);
  });
  it('endpoints that disagree on the owner fail closed', async () => {
    const fx = loadFixture('evm-lookups'); let n = 0;
    const calls = fx.calls.map((c) => (c.host === 'eth.drpc.org' && c.method === 'eth_call' && JSON.stringify(c.params).includes('0x6352211e') && JSON.stringify(c.params).toLowerCase().includes('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d') && n++ === 0 ? { ...c, result: `0x${'0'.repeat(24)}${'1'.repeat(40)}` } : c));
    const p = evmProvider({ rpc: replay({ ...fx, calls }).rpc, now: clockOf(fx), indexers: {}, http: fetch });
    expect(await code(p.lookup('ethereum', { address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '1' }, null))).toBe('provider_disagreement:eth_call');
  });
  it('transfer logs of a token: in / out relative to the wallet, exact quantity, never a sale', async () => {
    const { p, fx } = evm('evm-events'), w = fx.wallet as string;
    const a = await p.lookup('ethereum', { address: '0x495f947276749Ce646f68AC8c248420045cb7b5e', tokenId: '81678603736433480652309471562595884520144065466341654349472628651124869562369' }, w), e = await p.events(a, null);
    expect(e).toMatchObject({ completeness: 'recent_window', note: 'last_1000_blocks', cursor: null }); expect(e.events).toHaveLength(1);
    expect(e.events[0]).toMatchObject({ type: 'transfer-in', from: '0x76Ba8674F08B13d6F78D74AA00c594cC9eD965D5', to: w, quantity: '1', price: null, tx: '0x3dcfd60de0554dac233365c62d2afeb0433b6ebe52297388180425e1727fece7', index: '765', blockRef: { number: '26433388' }, finality: 'finalized' });
    expect(e.events[0]!.id).toBe(`${a.key}|0x3dcfd60de0554dac233365c62d2afeb0433b6ebe52297388180425e1727fece7|765`);
  });
  it('no indexer configured: discovery is "blocked by provider" (named variable); manual additions are verified on-chain', async () => {
    const { p } = evm(), w = '0xf17017dD78887f7A6d03a81E36FfBdF67eac2B8a';
    const inv = await p.inventory('ethereum', w, { manual: ['0x0905b2277df5c7dd6c5e3399ece8a36621aebe85/5'], max: 50 });
    expect(inv.sections).toEqual([{ section: 'indexer', status: 'blocked_by_provider', code: 'no_indexer_configured', unlockedBy: 'NFT_EVM_INDEXER_URLS', source: null, count: 0, truncated: false }, { section: 'manual', status: 'ok', code: null, unlockedBy: null, source: 'evm-rpc', count: 1, truncated: false }]);
    expect(inv.assets.map((a) => [a.key, a.quantity, a.origin, a.ownership.heldByWallet])).toEqual([['evm:ethereum:0x0905b2277df5c7dd6c5e3399ece8a36621aebe85/5', '3', 'manual', true]]);
  });
  it('an indexer is a HINT: what it lists enters the inventory only if the chain confirms the wallet holds it', async () => {
    const w = '0xf17017dD78887f7A6d03a81E36FfBdF67eac2B8a', urls: string[] = [];
    // the shape of a Blockscout /api/v2/addresses/<a>/nft answer (fields observed live 2026-11-17: items[].id, .token.address_hash, .token_type, .value; next_page_params)
    const http = (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ items: [
      { id: '5', token_type: 'ERC-1155', value: '3', token: { address_hash: '0x0905b2277df5c7dd6c5e3399ece8a36621aebe85', name: 'whatever the indexer says', type: 'ERC-1155' } },   // really held (balanceOf = 3)
      { id: '1', token_type: 'ERC-721', value: '1', token: { address_hash: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', name: 'BoredApeYachtClub', type: 'ERC-721' } },      // NOT held: the chain names another owner
      { id: '1', token_type: 'ERC-721', value: '1', token: { address_hash: '0xdAC17F958D2ee523a2206206994597C13D831ec7', type: 'ERC-721' } },                                   // not an NFT contract
      { id: 'not-a-number', token: { address_hash: '0x0905b2277df5c7dd6c5e3399ece8a36621aebe85' } }, { id: '7', token: { address_hash: 'javascript:alert(1)' } }], next_page_params: null }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const { p } = evm('evm-lookups', { ethereum: 'https://indexer.example' }, http);
    const inv = await p.inventory('ethereum', w, { manual: [], max: 50 });
    expect(urls).toEqual([`https://indexer.example/api/v2/addresses/${w}/nft?type=ERC-721%2CERC-1155`]);
    expect(inv.assets.map((a) => a.key)).toEqual(['evm:ethereum:0x0905b2277df5c7dd6c5e3399ece8a36621aebe85/5']);
    expect(inv.assets[0]!.quantity).toBe('3'); expect(inv.assets[0]!.collection?.name).not.toBe('whatever the indexer says'); // names come from the contract, not from the indexer
    expect(inv.assets[0]!.sources.map((s) => s.category)).toContain('indexed'); expect(inv.assets[0]!.ownership.source.category).toBe('onchain');
    expect(inv.sections[0]).toMatchObject({ section: 'indexer', status: 'ok', count: 1, code: 'not_confirmed_on_chain:2', source: 'evm-indexer (indexer.example)' });
  });
  it('indexer outage: its section is an error; the manual list still works', async () => {
    const http = (async () => new Response('upstream', { status: 503 })) as unknown as typeof fetch, { p } = evm('evm-lookups', { ethereum: 'https://indexer.example' }, http);
    const inv = await p.inventory('ethereum', '0xf17017dD78887f7A6d03a81E36FfBdF67eac2B8a', { manual: ['0x0905b2277df5c7dd6c5e3399ece8a36621aebe85/5'], max: 50 });
    expect(inv.sections.map((s) => [s.section, s.status, s.code])).toEqual([['indexer', 'error', 'provider_unavailable'], ['manual', 'ok', null]]); expect(inv.assets).toHaveLength(1);
  });
});

describe('market read source (Magic Eden public API, recorded) — category "market", never chain truth', () => {
  const fx = JSON.parse(JSON.stringify(loadFixture('market-magiceden'))) as unknown as { recordedAt: string; calls: { url: string; status: number; body: unknown }[] };
  const http = (async (url: string) => { const c = fx.calls.find((x) => x.url === url); if (!c) throw new Error(`unrecorded GET ${url}`); return new Response(JSON.stringify(c.body), { status: c.status }); }) as unknown as typeof fetch;
  const m = magicEdenMarket({ http, now: () => new Date(fx.recordedAt) });
  const asset = (assetId: string, standard = 'metaplex-core') => ({ family: 'sol', chainId: 'solana', assetId, standard } as NftAsset);
  it('the reference item was not listed: no price, no seller; the collection floor is given as a floor, in SOL base units', async () => {
    const s = await m.snapshot(asset(REF));
    expect(s.listed).toEqual({ state: 'known', value: false }); expect(s.listingPrice.state).toBe('none'); expect(s.seller.state).toBe('none'); expect(s.marketCollection).toBe('phygitals___');
    expect(s.collectionFloor).toMatchObject({ state: 'known', value: { currency: { network: 'solana', asset: 'native', symbol: 'SOL', decimals: 9 } } }); expect((s.collectionFloor as { value: { amount: string } }).value.amount).toMatch(/^[0-9]+$/);
    expect(s.source).toMatchObject({ category: 'market', source: 'magiceden', confidence: 'market_reported' }); expect(s.lastSale.state).toBe('unknown'); expect(s.bestOffer.state).toBe('unknown');
  });
  it('a listed item: exact asking price in lamports; the marketplace\'s SELLER is not the on-chain holder (the escrow)', async () => {
    const s = await m.snapshot(asset('J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo', 'metaplex-token-metadata'));
    expect(s.listed).toEqual({ state: 'known', value: true }); expect(s.listingPrice).toEqual({ state: 'known', value: { amount: '915900000', currency: { network: 'solana', asset: 'native', symbol: 'SOL', decimals: 9 } } });
    expect(s.seller).toEqual({ state: 'known', value: 'EuVNEdz5yHiR9kY8KZHPbYfFzX9nS4CFQPmAdPngyH9P' }); // on-chain (sol-legacy-escrow) the holder is 1BWutm…: two different facts, two different fields
  });
  it('failures have stable codes and never a body', async () => {
    expect(await code(m.snapshot(asset('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T')))).toMatch(/^(not_found|provider_bad_answer)/);
    const down = magicEdenMarket({ http: (async () => { throw new Error('ECONNRESET secret-in-message'); }) as never, now: () => new Date() });
    const e = await down.snapshot(asset(REF)).catch((x: Error) => x); expect((e as NftProviderError).code).toBe('provider_unavailable'); expect((e as Error).message).not.toContain('secret');
    const limited = magicEdenMarket({ http: (async () => new Response('slow down', { status: 429 })) as never, now: () => new Date() });
    expect(await code(limited.snapshot(asset(REF)))).toBe('provider_rate_limited');
    expect(m.supports(asset(REF))).toBe(true); expect(m.supports(asset('x', 'metaplex-bubblegum'))).toBe(false); expect(m.supports({ family: 'evm', standard: 'erc721' } as NftAsset)).toBe(false);
  });
  it('links to marketplaces are built without any request and only for chains the marketplace names', () => {
    expect(externalMarketLinks({ family: 'sol', chainId: 'solana', assetId: REF, contractAddress: null, tokenId: null, standard: 'metaplex-core' })).toEqual([{ name: 'Magic Eden', url: `https://magiceden.io/item-details/${REF}` }, { name: 'OpenSea', url: `https://opensea.io/item/solana/${REF}` }]);
    expect(externalMarketLinks({ family: 'evm', chainId: 'base', assetId: 'x', contractAddress: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '7', standard: 'erc721' })).toEqual([{ name: 'OpenSea', url: 'https://opensea.io/item/base/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/7' }]);
    expect(externalMarketLinks({ family: 'evm', chainId: 'bsc', assetId: 'x', contractAddress: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '7', standard: 'erc721' })).toEqual([]);
  });
});
