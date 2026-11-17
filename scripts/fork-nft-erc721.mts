// NFT delivery 2 — proof on a LOCAL FORK of Ethereum mainnet (anvil): an ERC-721 token of a real collection is SENT through the
// full path  API prepare (re-verification on both endpoints, simulation) → canonical NFT intent → passkey → signer (builds the
// transaction, verifies, signs) → broadcast → finality  and the result is read back from the fork; then the refusals, end to end.
//
//   npx tsx scripts/fork-nft-erc721.mts            (one fork at a time: `pkill -f anvil; sleep 3` first; database spw_fork_nft)
//
// Subject: Bored Ape Yacht Club (0xBC4C…f13D), token ids 1 and 2. The CURRENT holder of each is read on the fork at run time
// (`ownerOf`) and impersonated to hand the token to the test wallet — the script does not depend on who holds them.
// What this establishes: the calldata the signer builds is accepted by the real contract code and moves exactly the named
// token; the API's verdicts match the contract's behaviour; the signer refuses a tampered intent.
// What it does NOT establish: anything about mainnet execution (fees, inclusion, reorgs) — nothing was ever sent to a real network.
import { decodeFunctionData, encodeFunctionData, erc721Abi, getAddress, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { expectStatus, startForkStack } from './lib/fork-nft.mts';

const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', USDC = '0xA0b86991c6218b36c1d19D4a9e2783cE3606eB48';
// two fresh addresses (their keys are thrown away): well-known test addresses carry code on mainnet today (EIP-7702 delegations) and would be contracts
const FRIEND = privateKeyToAccount(generatePrivateKey()).address, OTHER = privateKeyToAccount(generatePrivateKey()).address, DELEGATED = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const s = await startForkStack({ port: 8561, db: 'spw_fork_nft' });
const ownerOf = async (id: bigint) => getAddress(`0x${(await s.rpc<string>('eth_call', [{ to: BAYC, data: encodeFunctionData({ abi: erc721Abi, functionName: 'ownerOf', args: [id] }) }, 'latest'])).slice(26)}`);
const key = (id: bigint) => `evm:ethereum:${BAYC.toLowerCase()}/${id}`;
const say = (m: string) => console.log(m);
try {
  // ── funding of the fork: the current holders hand tokens 1 and 2 to the test wallet ─────────────────────────────────────
  for (const id of [1n, 2n]) { const holder = await ownerOf(id);
    await s.impersonate(holder, BAYC, encodeFunctionData({ abi: erc721Abi, functionName: 'transferFrom', args: [holder as `0x${string}`, s.me as `0x${string}`, id] }));
    if ((await ownerOf(id)) !== s.me) throw new Error(`token ${id} did not reach the test wallet on the fork`);
    say(`fork: BAYC #${id} moved from its current holder ${holder} to the test wallet ${s.me}`); }

  // ── the item as the wallet sees it: tracked by contract + token id, verified on-chain, transferable ────────────────────
  const added = await s.api('POST', '/api/v1/nfts/manual', { chain: 'ethereum', address: BAYC, tokenId: '1' });
  expectStatus('manual add', added, 200);
  const verdict = (await s.api('GET', `/api/v1/nfts/transfer/verdict?key=${encodeURIComponent(key(1n))}`)).json;
  say(`verdict of ${key(1n)}: transferable=${verdict.transferable} route="${verdict.route}" blockedBy=[${verdict.blockedBy}]`);
  if (!verdict.transferable) throw new Error('the token held by the wallet is not reported transferable');

  // ── SEND #1 to an ordinary account ─────────────────────────────────────────────────────────────────────────────────────
  const prep = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(1n), to: FRIEND }, crypto.randomUUID());
  expectStatus('prepare', prep, 200);
  const rv = prep.json.review, it = prep.json.intent;
  say(`review: ${rv.standard} · ${rv.method} · contract ${rv.asset} · token id ${rv.tokenId} · quantity ${rv.quantity} · to ${rv.to} (${rv.toKind}) · network ${rv.networkName} · fee ≤ ${rv.fee.max} wei`);
  say(`        verified: ${rv.verified.standard}; ${rv.verified.ownership} (on ${rv.verified.endpoints} endpoints); simulation: ${rv.simulation.detail}, gas ${rv.simulation.used}`);
  say(`        creator metadata (unverified): name=${JSON.stringify(rv.creatorMetadata.name)}`);
  if (it.kind !== 'nft-transfer' || it.asset !== BAYC || it.tokenId !== '1' || it.to !== FRIEND || it.from !== s.me || it.chainRef !== '1') throw new Error('the intent does not carry the on-chain identifiers of the request');
  // the same request again answers the same proposal (idempotency), not a second one
  const sent = await s.api('POST', `/api/v1/nfts/transfer/${prep.json.proposal.id}/approve`, { assertion: s.pk.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
  expectStatus('approve', sent, 200);
  if (sent.json.state !== 'broadcast') throw new Error(`after approval the transfer is ${sent.json.state}, expected broadcast`);
  const raw = (await s.sql`select raw from proposals where id = ${prep.json.proposal.id}`)[0].raw as `0x${string}`, tx = parseTransaction(raw), call = decodeFunctionData({ abi: erc721Abi, data: tx.data! });
  say(`signed transaction: to ${tx.to} value ${tx.value ?? 0n} ${call.functionName}(${call.args!.join(', ')}) — ${(tx.data!.length - 2) / 2} bytes of calldata`);
  if (call.functionName !== 'safeTransferFrom' || call.args!.length !== 3) throw new Error('the signed call is not safeTransferFrom(address,address,uint256)');
  const done = await s.settle(prep.json.proposal.id);
  if (done.state !== 'finalized') throw new Error(`the transfer ended ${done.state}: ${done.error}`);
  if ((await ownerOf(1n)) !== FRIEND) throw new Error('ownerOf(1) is not the destination after finality');
  say(`SENT: ${done.state}, tx ${done.txid}; ownerOf(1) on the fork = ${await ownerOf(1n)} (the destination)`);
  const after = (await s.api('GET', `/api/v1/nfts/item?key=${encodeURIComponent(key(1n))}`)).json;
  const act = (await s.api('GET', `/api/v1/nfts/activity?key=${encodeURIComponent(key(1n))}`)).json;
  say(`inventory after finality: inWallet=${after.ownership.heldByWallet} state=${after.ownership.state} blockedBy=[${after.transfer.blockedBy}]; activity: ${act.events.filter((e: { tx: string }) => e.tx === done.txid).map((e: { type: string; finality: string }) => `${e.type}/${e.finality}`).join(', ')}`);
  if (after.ownership.heldByWallet) throw new Error('the inventory still shows the token in the wallet after finality');

  // ── REFUSALS, end to end ───────────────────────────────────────────────────────────────────────────────────────────────
  // 1. a token the wallet no longer holds (the one just sent), and one it never held
  const gone = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(1n), to: OTHER }, crypto.randomUUID());
  say(`refused — token no longer held: ${gone.status} ${gone.json.error} — ${gone.json.message}`);
  if (gone.status !== 422 || !/not_in_wallet|not_owned/.test(gone.json.error)) throw new Error('a token that left the wallet was not refused');
  await s.api('POST', '/api/v1/nfts/lookup', { chain: 'ethereum', address: BAYC, tokenId: '3' });
  const never = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(3n), to: OTHER }, crypto.randomUUID());
  say(`refused — token of another holder: ${never.status} ${never.json.error}`);
  if (never.status !== 422) throw new Error('a token of another holder was not refused');
  // 2. a contract recipient that does not implement the receiver interface: caught by the simulation, before any passkey prompt
  await s.api('POST', '/api/v1/nfts/manual', { chain: 'ethereum', address: BAYC, tokenId: '2' });
  const toContract = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to: WETH }, crypto.randomUUID());
  say(`refused — contract recipient without onERC721Received (WETH): ${toContract.status} ${toContract.json.error} — ${toContract.json.message}`);
  expectStatus('contract recipient', toContract, 422, 'nft_transfer_simulation_reverted');
  // 2b. found while writing this proof: a well-known test ADDRESS that carries code on mainnet today — the API calls it a contract and the simulation refuses it
  const delegated = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to: DELEGATED }, crypto.randomUUID());
  say(`refused — an address that carries code on mainnet (${DELEGATED}): ${delegated.status} ${delegated.json.error} (toKind=${delegated.json.data?.toKind})`);
  // 3. the contract itself, the wallet itself, the zero address
  for (const [to, code] of [[BAYC, 'nft_transfer_destination_is_contract_itself'], [s.me, 'nft_transfer_destination_is_wallet'], ['0x0000000000000000000000000000000000000000', 'nft_transfer_bad_destination']] as const) {
    const r = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to }, crypto.randomUUID());
    say(`refused — destination ${to}: ${r.status} ${r.json.error}`); if (r.json.error !== code) throw new Error(`destination ${to} was not refused with ${code}`); }
  // 4. a fungible token presented as an NFT: refused by the lookup (no ERC-721 behaviour) — and by the signer's builder in any case
  const erc20 = await s.api('POST', '/api/v1/nfts/lookup', { chain: 'ethereum', address: USDC, tokenId: '1' });
  say(`refused — ERC-20 (USDC) presented as an NFT: ${erc20.status} ${erc20.json?.error}`);
  if (erc20.status === 200) throw new Error('an ERC-20 was accepted as an NFT');
  // 5. a compromised API / database changes the approved intent after the review (another token id, another destination): the signer refuses
  for (const [what, patch] of [['token id 2 → 4', { tokenId: '4' }], ['destination → another address', { to: OTHER }]] as const) {
    const p = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to: FRIEND }, crypto.randomUUID());
    expectStatus('prepare', p, 200);
    const assertion = s.pk.assert(Buffer.from(p.json.options.challenge, 'base64url'));
    await s.sql`update proposals set intent = ${s.sql.json({ ...p.json.intent, ...patch })} where id = ${p.json.proposal.id}`;
    const r = await s.api('POST', `/api/v1/nfts/transfer/${p.json.proposal.id}/approve`, { assertion });
    say(`refused — intent tampered after the review (${what}): ${r.status} ${r.json.error} — ${r.json.message}`);
    expectStatus('tampered intent', r, 422, 'signer_bad_approval');
  }
  if ((await ownerOf(2n)) !== s.me) throw new Error('token 2 moved although every attempt was refused');
  // 6. an NFT proposal on the ORDINARY approval route, and the same Idempotency-Key with another request
  const k1 = crypto.randomUUID(), p6 = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to: FRIEND }, k1);
  const again = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to: FRIEND }, k1);
  if (again.json.proposal.id !== p6.json.proposal.id || again.json.replayed !== true) throw new Error('the same Idempotency-Key did not answer the same proposal');
  expectStatus('same key, another request', await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to: OTHER }, k1), 409, 'idempotency_mismatch');
  expectStatus('ordinary approve route', await s.api('POST', `/api/v1/transfers/proposals/${p6.json.proposal.id}/approve`, { assertion: s.pk.assert(Buffer.from(p6.json.options.challenge, 'base64url')) }), 409, 'bad_state');
  say('idempotency: same key → same proposal; same key + another request → 409; the ordinary approval route refuses an NFT proposal (409)');
  // 7. the emergency halt: not a risk reduction — nothing is prepared, nothing is signed
  s.signer.halt();
  const halted = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key: key(2n), to: FRIEND }, crypto.randomUUID());
  say(`refused — signer halted: ${halted.status} ${halted.json.error}`);
  const forced = await s.api('POST', `/api/v1/nfts/transfer/${p6.json.proposal.id}/approve`, { assertion: s.pk.assert(Buffer.from(p6.json.options.challenge, 'base64url')) });
  say(`refused — approval of an already prepared transfer under halt: ${forced.status} ${forced.json.error}`);
  if (halted.status !== 423 || forced.json.error !== 'signer_nft_halted') throw new Error('the halt did not stop NFT transfers');
  if ((await ownerOf(2n)) !== s.me) throw new Error('token 2 moved under halt');
  say(`signer journal: ${s.store.journalRecords().filter((r) => r.type.startsWith('nft.')).map((r) => `${r.type}${r.data.code ? `(${r.data.code})` : ''}`).join(', ')}`);
  say('NFT ERC-721 FORK PROOF OK (Ethereum fork; nothing was sent to a real network)');
} finally { await s.close(); }
