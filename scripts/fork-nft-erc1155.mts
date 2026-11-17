// NFT delivery 2 — proof on a LOCAL FORK of Ethereum mainnet (anvil): units of an ERC-1155 token id of a real contract are SENT
// through the full path (API prepare → NFT intent → passkey → signer → broadcast → finality), with SPW_BROADCAST honoured, and
// the refusals end to end. Same harness and same caveats as scripts/fork-nft-erc721.mts: a fork is not a mainnet execution.
//
//   npx tsx scripts/fork-nft-erc1155.mts           (one fork at a time: `pkill -f anvil; sleep 3` first; database spw_fork_nft)
//
// Subject: the OpenSea Shared Storefront (0x495f…7b5e), an ERC-1155 contract with daily transfers. The token id and its CURRENT
// holder are found at run time from the most recent `TransferSingle` log of the contract whose receiver still holds the
// units (balanceOf on the fork) — no fixed holder, no fixed token id. The holder is impersonated to hand units to the test wallet.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, numberToHex, parseAbi, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { expectStatus, startForkStack } from './lib/fork-nft.mts';

const STOREFRONT = '0x495f947276749Ce646f68AC8c248420045cb7b5e', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const TOPIC_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const abi = parseAbi(['function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)', 'function balanceOf(address account, uint256 id) view returns (uint256)']);
const FRIEND = privateKeyToAccount(generatePrivateKey()).address, OTHER = privateKeyToAccount(generatePrivateKey()).address;
const say = (m: string) => console.log(m);

const s = await startForkStack({ port: 8562, db: 'spw_fork_nft', broadcast: 'on' });
const balanceOf = async (who: string, id: bigint) => BigInt(await s.rpc<string>('eth_call', [{ to: STOREFRONT, data: encodeFunctionData({ abi, functionName: 'balanceOf', args: [who as `0x${string}`, id] }) }, 'latest']));
try {
  // ── find a token id and a current holder from the contract's own recent logs ─────────────────────────────────────────────
  const head = Number(BigInt(await s.rpc<string>('eth_blockNumber')));
  let subject: { id: bigint; holder: string; units: bigint } | null = null;
  for (let hi = head, tries = 0; !subject && tries < 12; hi -= 5000, tries++) {
    const logs = await s.rpc<{ topics: string[]; data: `0x${string}` }[]>('eth_getLogs', [{ address: STOREFRONT, topics: [TOPIC_SINGLE], fromBlock: numberToHex(Math.max(0, hi - 4999)), toBlock: numberToHex(hi) }]);
    for (const l of logs.reverse()) { const [id] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], l.data), holder = getAddress(`0x${l.topics[3]!.slice(26)}`);
      if (/^0x0{40}$/i.test(holder)) continue; const units = await balanceOf(holder, id); if (units >= 1n) { subject = { id, holder, units }; break; } }
  }
  if (!subject) throw new Error('no current holder found in the recent TransferSingle logs of the contract (try again later, or set ETH_RPC to an endpoint with a longer log range)');
  const { id, holder } = subject, key = `evm:ethereum:${STOREFRONT.toLowerCase()}/${id}`;
  say(`subject found on the fork: token id ${id}, current holder ${holder} holds ${subject.units} unit(s)`);
  await s.impersonate(holder, STOREFRONT, encodeFunctionData({ abi, functionName: 'safeTransferFrom', args: [holder as `0x${string}`, s.me as `0x${string}`, id, 1n, '0x'] }));
  if ((await balanceOf(s.me, id)) !== 1n) throw new Error('the unit did not reach the test wallet on the fork');
  say(`fork: 1 unit handed to the test wallet ${s.me}`);

  expectStatus('manual add', await s.api('POST', '/api/v1/nfts/manual', { chain: 'ethereum', address: STOREFRONT, tokenId: id.toString() }), 200);
  const item = (await s.api('GET', `/api/v1/nfts/item?key=${encodeURIComponent(key)}`)).json;
  say(`item: standard ${item.standard}, quantity held ${item.quantity}, transferable=${item.transfer.transferable}, warnings=[${item.transfer.warnings}]`);
  if (item.standard !== 'erc1155' || item.quantity !== '1' || !item.transfer.transferable) throw new Error('the ERC-1155 unit is not reported as held and transferable');

  // ── refusals first (the unit must still be there afterwards) ───────────────────────────────────────────────────────────
  const tooMany = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key, to: FRIEND, quantity: '2' }, crypto.randomUUID());
  say(`refused — quantity 2 when 1 is held: ${tooMany.status} ${tooMany.json.error} — ${tooMany.json.message}`);
  expectStatus('quantity above balance', tooMany, 422, 'nft_transfer_insufficient_quantity');
  expectStatus('quantity zero', await s.api('POST', '/api/v1/nfts/transfer/prepare', { key, to: FRIEND, quantity: '0' }, crypto.randomUUID()), 400);
  const toContract = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key, to: WETH }, crypto.randomUUID());
  say(`refused — contract recipient without onERC1155Received (WETH): ${toContract.status} ${toContract.json.error} — ${toContract.json.message}`);
  expectStatus('contract recipient', toContract, 422, 'nft_transfer_simulation_reverted');
  // a compromised API raises the quantity / changes the token id after the review: the signer refuses
  for (const [what, patch] of [['quantity 1 → 5', { quantity: '5' }], ['token id → another id', { tokenId: (id ^ 1n).toString() }]] as const) {
    const p = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key, to: FRIEND }, crypto.randomUUID());
    expectStatus('prepare', p, 200);
    const assertion = s.pk.assert(Buffer.from(p.json.options.challenge, 'base64url'));
    await s.sql`update proposals set intent = ${s.sql.json({ ...p.json.intent, ...patch })} where id = ${p.json.proposal.id}`;
    const r = await s.api('POST', `/api/v1/nfts/transfer/${p.json.proposal.id}/approve`, { assertion });
    say(`refused — intent tampered after the review (${what}): ${r.status} ${r.json.error}`);
    expectStatus('tampered intent', r, 422, 'signer_bad_approval');
  }
  if ((await balanceOf(s.me, id)) !== 1n) throw new Error('the unit moved although every attempt was refused');

  // ── SPW_BROADCAST=off: signed, deliberately NOT relayed — the honest `not_broadcast` state, nothing moves ───────────────
  const cfg = (await import('../services/api/src/config.ts')).config as { broadcast: boolean };
  cfg.broadcast = false;
  const nb = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key, to: OTHER }, crypto.randomUUID());
  expectStatus('prepare', nb, 200);
  const held = await s.api('POST', `/api/v1/nfts/transfer/${nb.json.proposal.id}/approve`, { assertion: s.pk.assert(Buffer.from(nb.json.options.challenge, 'base64url')) });
  say(`broadcast disabled: state ${held.json.state}, error code ${held.json.errorCode}, explorer link ${held.json.explorer}; balance of the wallet still ${await balanceOf(s.me, id)}`);
  if (held.json.state !== 'not_broadcast' || held.json.explorer !== null || (await balanceOf(s.me, id)) !== 1n) throw new Error('a transfer was relayed, or shown as sent, with broadcasting disabled');
  cfg.broadcast = true;

  // ── SEND 1 unit to an ordinary account (the nonce is free: the signed-but-unsent transaction above was never relayed) ───
  const prep = await s.api('POST', '/api/v1/nfts/transfer/prepare', { key, to: FRIEND, quantity: '1' }, crypto.randomUUID());
  expectStatus('prepare', prep, 200);
  const rv = prep.json.review;
  say(`review: ${rv.standard} · ${rv.method} · contract ${rv.asset} · token id ${rv.tokenId} · quantity ${rv.quantity} · to ${rv.to} (${rv.toKind}) · fee ≤ ${rv.fee.max} wei · warnings [${rv.warnings}]`);
  say(`        verified: ${rv.verified.standard}; ${rv.verified.ownership}; simulation gas ${rv.simulation.used}`);
  const sent = await s.api('POST', `/api/v1/nfts/transfer/${prep.json.proposal.id}/approve`, { assertion: s.pk.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
  expectStatus('approve', sent, 200);
  const raw = (await s.sql`select raw from proposals where id = ${prep.json.proposal.id}`)[0].raw as `0x${string}`, tx = parseTransaction(raw), call = decodeFunctionData({ abi, data: tx.data! });
  say(`signed transaction: to ${tx.to} value ${tx.value ?? 0n} ${call.functionName}(${call.args!.map(String).join(', ')}) — ${(tx.data!.length - 2) / 2} bytes of calldata`);
  if (call.functionName !== 'safeTransferFrom' || call.args![4] !== '0x' || call.args![3] !== 1n) throw new Error('the signed call is not safeTransferFrom(from, to, id, 1, "")');
  const done = await s.settle(prep.json.proposal.id);
  if (done.state !== 'finalized') throw new Error(`the transfer ended ${done.state}: ${done.error}`);
  const [mine, theirs] = [await balanceOf(s.me, id), await balanceOf(FRIEND, id)];
  say(`SENT: ${done.state}, tx ${done.txid}; balanceOf(wallet) = ${mine}, balanceOf(destination) = ${theirs}`);
  if (mine !== 0n || theirs !== 1n) throw new Error('the balances after finality are not the expected ones');
  const after = (await s.api('GET', `/api/v1/nfts/item?key=${encodeURIComponent(key)}`)).json;
  say(`inventory after finality: quantity ${after.quantity}, inWallet=${after.ownership.heldByWallet}, blockedBy=[${after.transfer.blockedBy}]`);
  // nothing else of value moved, and no operator approval exists for anyone
  const approved = await s.rpc<string>('eth_call', [{ to: STOREFRONT, data: encodeFunctionData({ abi: parseAbi(['function isApprovedForAll(address account, address operator) view returns (bool)']), functionName: 'isApprovedForAll', args: [s.me as `0x${string}`, FRIEND] }) }, 'latest']);
  if (BigInt(approved) !== 0n) throw new Error('an operator approval exists after the transfer');
  say('isApprovedForAll(wallet, destination) = false: the transfer granted no approval');
  say(`signer journal: ${s.store.journalRecords().filter((r) => r.type.startsWith('nft.')).map((r) => `${r.type}${r.data.code ? `(${r.data.code})` : ''}`).join(', ')}`);
  say('NFT ERC-1155 FORK PROOF OK (Ethereum fork; nothing was sent to a real network)');
} finally { await s.close(); }
