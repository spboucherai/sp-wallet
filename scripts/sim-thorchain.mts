// THORChain native swap proof. NOTHING is sent to a real network and no real key is used: the wallet is a fresh random
// mnemonic created by this script.     node scripts/sim-thorchain.mts
//
//   Part 1  read-only, LIVE THORNode operators: the vault unanimity check with real answers, then the same answers tampered with
//           (one lying operator, a stale one, a halted chain, an attacker's key); vault addresses derived locally from the vault
//           key; quotes for several pairs from every operator, each quote's own `memo` compared byte for byte with the memo this
//           wallet builds; the pinned router bytecode; what the chains themselves show about the vault.
//   Part 2  native BTC source: the REAL signer (passkey, policy, its own live vault check) signs a Bitcoin transaction that
//           spends a made-up coin. It is decoded and checked (outputs, OP_RETURN bytes, fee) and NEVER broadcast.
//           Then the refusals: a substituted vault, a memo paying someone else, a lower limit.
//   Part 3  Ethereum source on a LOCAL anvil fork: the signer's router call is mined against the real THORChain Router bytecode,
//           up to its Deposit event (vault, asset, amount, memo). ETH and USDC (exact approval). Expiry reverts.
//
// WHAT CANNOT BE SIMULATED: THORChain itself. A deposit made on a fork (or a Bitcoin transaction that is not broadcast) is
// never observed by the network, so the swap, the outbound transaction and a refund are not exercised here.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as bitcoin from 'bitcoinjs-lib'; // an independent decoder for the signed Bitcoin transaction
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, keccak256, numberToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildThorMemo, checkThorVault, encodeThorPubKey, estimateXswapVsize, fetchThorViews, fromThorAmount, intentHash, IntentSchema, NETWORKS, parseThorMemo, pickThorVault, THOR_ASSETS, THOR_MIN_OPERATORS, THOR_ROUTER_ABI, THOR_ROUTERS,
  thorAsset, THORNODE_OPERATORS, thorVaultAddress, toThorAmount, utxoPaymentTo, type Intent, type ThorAnswer, type ThorAsset, type ThorGet, type ThorView,
} from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';
import { thorVaults, vaultHosts } from '../services/isolated-signer/src/vaults.ts';

for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', SPW_SIGNER_SECRET: 'x'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' })) process.env[k] ??= v;
const { agreeQuotes, fetchQuotes, thorGet } = await import('../services/api/src/xswap.ts'); // the API's own quote comparison (no database is touched)

const say = (s = '') => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
async function refused(label: string, p: Promise<unknown> | (() => unknown), re: RegExp) {
  try { await (typeof p === 'function' ? p() : p); check(false, `${label}: was NOT refused`); } catch (e) { const m = (e as Error).message; check(re.test(m), `${label} -> refused: ${m.slice(0, 150)}`); }
}
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(generateMnemonic(wordlist, 128)); // fresh throwaway wallet, never funded
const ME = { bitcoin: keys.addresses.bitcoin!, ethereum: keys.addresses.ethereum!, litecoin: keys.addresses.litecoin!, dogecoin: keys.addresses.dogecoin! } as Record<string, string>;
const eth = NETWORKS.ethereum!, USDC = eth.tokens.find((t) => t.symbol === 'USDC')!.id, ROUTER = THOR_ROUTERS.ethereum!;
const sha = (h: string) => createHash('sha256').update(Buffer.from(h.slice(2), 'hex')).digest('hex');
/** a valid secp256k1 key that is no vault: a fresh random one, compressed */
const fakeKey = () => { const u = Buffer.from(privateKeyToAccount(generatePrivateKey()).publicKey.slice(2), 'hex'); return encodeThorPubKey(new Uint8Array([2 + (u[64]! & 1), ...u.subarray(1, 33)])); };

say('THORChain native swap proof — nothing is broadcast, the wallet is a fresh random test mnemonic');
say(`test wallet: BTC ${ME.bitcoin}  ETH ${ME.ethereum}`);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
say('\n== Part 1 — live THORNode operators (read-only) ==');
const get: ThorGet = thorGet;
const answers = await fetchThorViews(get);
for (const a of answers) say(`  ${a.operator.padEnd(10)} ${new URL(THORNODE_OPERATORS.find((o) => o.id === a.operator)!.base).host.padEnd(28)} ${'view' in a ? `height ${a.view.height}, ${a.view.vaults.filter((v) => v.status === 'ActiveVault').length} active vault(s), BTC inbound ${a.view.inbound.find((x) => x.chain === 'BTC')?.address}` : `NO ANSWER (${a.error})`}`);
const live = answers.filter((a): a is { operator: string; view: ThorView } => 'view' in a);
check(live.length >= THOR_MIN_OPERATORS, `${live.length} of ${answers.length} pinned operators answered (at least ${THOR_MIN_OPERATORS} are required)`);
const vaultKey = { BTC: pickThorVault(answers, 'BTC')!, ETH: pickThorVault(answers, 'ETH')!, LTC: pickThorVault(answers, 'LTC')! };
const wantBtc = { chain: 'BTC', vaultPubKey: vaultKey.BTC, router: null, amount: 60_000n }, wantEth = { chain: 'ETH', vaultPubKey: vaultKey.ETH, router: ROUTER.address, amount: 2_000_000n };
const vBtc = checkThorVault(answers, wantBtc), vEth = checkThorVault(answers, wantEth);
say(`  BTC vault key ${vaultKey.BTC}`);
check(true, `unanimity BTC: ${vBtc.operators.join(', ')} all list it ActiveVault since block ${vBtc.statusSince}; chain not halted; gas rate ${vBtc.gasRate} sat/vB; dust ${vBtc.dustThreshold}; ${vBtc.members} members${vBtc.silent.length ? `; silent: ${vBtc.silent.join(', ')}` : ''}`);
check(true, `unanimity ETH: ${vEth.operators.join(', ')}; router named by all = pinned ${ROUTER.address}; gas rate ${vEth.gasRate} gwei`);
const VAULT_BTC = thorVaultAddress(vaultKey.BTC, 'bitcoin'), VAULT_ETH = thorVaultAddress(vaultKey.ETH, 'ethereum');
check(live.every((a) => a.view.inbound.filter((x) => x.pubKey === vaultKey.BTC && x.chain === 'BTC').every((x) => x.address === VAULT_BTC)), `BTC vault address derived locally from the key = the address the operators publish: ${VAULT_BTC}`);
check(live.every((a) => a.view.inbound.filter((x) => x.pubKey === vaultKey.ETH && x.chain === 'ETH').every((x) => x.address.toLowerCase() === VAULT_ETH.toLowerCase())), `ETH vault address derived locally = published: ${VAULT_ETH}`);
// the same real answers, tampered with
const tamper = (k: number, f: (v: ThorView) => ThorView): ThorAnswer[] => answers.map((a, j) => (j === answers.indexOf(live[k]!) && 'view' in a ? { operator: a.operator, view: f(structuredClone(a.view)) } : a));
const attacker = fakeKey();
await refused('an attacker\'s key that no operator knows', () => checkThorVault(answers, { ...wantBtc, vaultPubKey: attacker }), /does not list this vault/);
await refused('an attacker\'s key that ONE lying operator vouches for', () => checkThorVault(tamper(0, (v) => ({ ...v, vaults: [...v.vaults, { pubKey: attacker, status: 'ActiveVault', statusSince: vBtc.statusSince, chains: ['BTC'], members: 19 }] })), { ...wantBtc, vaultPubKey: attacker }), /does not list this vault/);
await refused('one operator denying the real vault', () => checkThorVault(tamper(1, (v) => ({ ...v, vaults: v.vaults.filter((x) => x.pubKey !== vaultKey.BTC) })), wantBtc), /does not list this vault/);
await refused('one stale operator (100 blocks behind)', () => checkThorVault(tamper(0, (v) => ({ ...v, height: v.height - 100 })), wantBtc), /blocks behind/);
await refused('one operator reporting BTC halted', () => checkThorVault(tamper(2, (v) => ({ ...v, inbound: v.inbound.map((x) => (x.chain === 'BTC' ? { ...x, halted: true } : x)) })), wantBtc), /halted/);
await refused('one operator listing the vault as retiring', () => checkThorVault(tamper(0, (v) => ({ ...v, vaults: v.vaults.map((x) => (x.pubKey === vaultKey.BTC ? { ...x, status: 'RetiringVault' } : x)) })), wantBtc), /RetiringVault/);
await refused('only two operators answering', () => { let c = 0; return checkThorVault(answers.map((a) => ('view' in a && ++c > 2 ? { operator: a.operator, error: 'down' } : a)), wantBtc); }, /only 2 THORNode/);

say('\n  quotes (every operator, destination = the test wallet), memo THORChain expects vs memo this wallet builds:');
const BPS = 100;
const pairs: [ThorAsset, ThorAsset, bigint][] = [
  [thorAsset('bitcoin', 'native'), thorAsset('ethereum', 'native'), 60_000n], [thorAsset('bitcoin', 'native'), thorAsset('ethereum', USDC), 60_000n],
  [thorAsset('ethereum', 'native'), thorAsset('bitcoin', 'native'), 20_000_000_000_000_000n], [thorAsset('ethereum', USDC), thorAsset('bitcoin', 'native'), 45_000_000n],
  [thorAsset('litecoin', 'native'), thorAsset('bitcoin', 'native'), 90_000_000n], [thorAsset('bitcoin', 'native'), thorAsset('dogecoin', 'native'), 60_000n], [thorAsset('bitcoin', 'native'), thorAsset('litecoin', 'native'), 60_000n],
];
const agreedFor = new Map<string, Awaited<ReturnType<typeof agreeQuotes>>>();
for (const [src, dst, amount] of pairs) {
  let okq: Awaited<ReturnType<typeof fetchQuotes>> = [];
  await new Promise((r) => setTimeout(r, 1500));
  for (let k = 0; k < 4 && okq.length < 2; k++) okq = await fetchQuotes(src, dst, toThorAmount(amount, src.decimals), ME[dst.network]!, BPS).catch(() => []); // the API's own function; public nodes are often busy
  const rs = THORNODE_OPERATORS.map((o) => okq.find((r) => r.operator === o.id) ?? { operator: o.id });
  const label = `${src.symbol}(${src.network}) -> ${dst.symbol}(${dst.network})`;
  let same = okq.length >= 2;
  for (const r of okq) { const mine = buildThorMemo(dst, ME[dst.network]!, (BigInt(r.quote.expected_amount_out) * BigInt(10_000 - BPS)) / 10_000n); if (mine !== r.quote.memo) { same = false; say(`       ${r.operator}: THEIRS ${r.quote.memo}\n       ${''.padEnd(r.operator.length)}  OURS   ${mine}`); } }
  check(same, `${label}: ${okq.length} quote(s), each memo identical byte for byte, e.g. "${okq[0]?.quote.memo}" (${new TextEncoder().encode(okq[0]?.quote.memo ?? '').length} bytes)${rs.length - okq.length ? ` — no quote this time from ${rs.filter((r) => !okq.includes(r as never)).map((r) => r.operator).join(', ')} (busy or lagging node)` : ''}`);
  try {
    const a = agreeQuotes(okq, dst, ME[dst.network]!, BPS, src.network === 'ethereum' ? ROUTER.address : null); agreedFor.set(`${src.network}:${src.asset}>${dst.network}:${dst.asset}`, a);
    const p = parseThorMemo(a.memo);
    check(p.asset === dst && p.destination === ME[dst.network] && p.limit === a.limit, `   agreed by ${a.operators.join(', ')}: expected ${formatUnits(fromThorAmount(a.expected, dst.decimals), dst.decimals)} ${dst.symbol}, minimum ${formatUnits(fromThorAmount(a.limit, dst.decimals), dst.decimals)}, outbound fee ${formatUnits(fromThorAmount(a.outboundFee, dst.decimals), dst.decimals)} (already deducted), minimum input ${formatUnits(fromThorAmount(a.minAmountIn, src.decimals), src.decimals)} ${src.symbol}, ≈ ${a.seconds} s`);
  } catch (e) { check(false, `   ${label}: quotes not agreed: ${(e as Error).message.slice(0, 140)}`); }
}
say('\n  pinned assets and their pools:');
const pools = await get(`${THORNODE_OPERATORS[3]!.base}/thorchain/pools`) as { asset: string; status: string; short_code?: string }[];
for (const a of THOR_ASSETS) { const own = pools.filter((p) => p.asset === a.notation), same = a.memo.includes('.') ? pools.filter((p) => p.asset.startsWith(`${a.memo}-`)) : pools.filter((p) => p.short_code === a.memo);
  check(own.length === 1 && own[0]!.status === 'Available' && same.length === 1 && same[0]!.asset === a.notation, `${a.notation.slice(0, 22).padEnd(22)} Available; memo spelling "${a.memo}" designates this pool only`); }

say('\n  the chains themselves (second line, not a proof):');
const rpc = async <T,>(url: string, method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(j.error.message); return j.result; };
for (const u of eth.rpc) check(sha(await rpc<string>(u, 'eth_getCode', [ROUTER.address, 'latest'])) === ROUTER.codeSha256, `router bytecode on ${new URL(u).host} hashes to the pinned value ${ROUTER.codeSha256.slice(0, 16)}…`);
const vEthBal = hexToBigInt(await rpc<Hex>(eth.rpc[0]!, 'eth_getBalance', [VAULT_ETH, 'latest']));
const vUsdc = hexToBigInt(await rpc<Hex>(eth.rpc[0]!, 'eth_call', [{ to: ROUTER.address, data: encodeFunctionData({ abi: THOR_ROUTER_ABI, functionName: 'vaultAllowance', args: [VAULT_ETH as Hex, USDC as Hex] }) }, 'latest']));
check(vEthBal >= 100n * 20_000_000_000_000_000n, `ETH vault ${VAULT_ETH} holds ${formatUnits(vEthBal, 18)} ETH on-chain and ${formatUnits(vUsdc, 6)} USDC in the router (≥ 100 × a 0.02 ETH swap)`);
try { const s = await (await fetch(`${NETWORKS.bitcoin!.rpc[0]}/address/${VAULT_BTC}`)).json() as any; const bal = BigInt(s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum);
  check(bal >= 100n * 60_000n, `BTC vault ${VAULT_BTC} holds ${formatUnits(bal, 8)} BTC, ${s.chain_stats.tx_count} transactions (wallet's own Bitcoin data source)`); } catch (e) { check(false, `BTC vault balance: ${(e as Error).message}`); }
say(`  signer's outbound hosts for this check: ${vaultHosts().join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// the real signer, with a test passkey and its own LIVE vault view
const dir = mkdtempSync(join(tmpdir(), 'spw-thor-')), store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, undefined, undefined, thorVaults());
const pk = new TestPasskey(RP, ORIGIN);
store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
await signer.enroll({ credential: pk.credential(), setupToken: 't' });
const base = (network: string, asset: string, symbol: string, decimals: number, amount: bigint, to: string) => { const t = Math.floor(Date.now() / 1000); return { v: 1, proposalId: randomUUID(), keyId: keys.keyId, network, chainRef: NETWORKS[network]!.chainRef, asset, symbol, decimals, amount: amount.toString(), from: ME[network]!, to, createdAt: t, expiresAt: t + 120, policyVersion: store.policy.version }; };

/** Sign with the real signer. Public nodes are sometimes down or rate-limiting: when fewer than three answer, the signer refuses
 *  (fail closed) and this script says so, waits and asks again with a fresh intent. Any other refusal is an error. */
async function signLive(make: () => Intent): Promise<{ i: Intent; out: Awaited<ReturnType<Signer['sign']>> }> {
  for (let k = 0; ; k++) {
    const i = make();
    try { return { i, out: await signer.sign(i, pk.assert(intentHash(i))) }; }
    catch (e) { const m = (e as Error).message; if (k >= 5 || !/only \d+ THORNode operator/.test(m)) throw e; say(`  (signer refused, fail closed: ${m.slice(m.indexOf('only'), m.indexOf('only') + 110)} — waiting 25 s and asking again)`); await new Promise((r) => setTimeout(r, 25_000)); }
  }
}

say('\n== Part 2 — native BTC -> ETH: signed by the real signer, decoded, NOT broadcast ==');
const aBtc = agreedFor.get('bitcoin:native>ethereum:native');
if (!aBtc) check(false, 'no agreed BTC -> ETH quote: part 2 skipped');
else {
  const coin = { txid: randomBytes(32).toString('hex'), vout: 0, value: 150_000n }, amount = 60_000n; // a coin that does not exist
  const rate = Number(vBtc.gasRate ?? 3n), fee = BigInt(Math.ceil(estimateXswapVsize(1, VAULT_BTC, aBtc.memo, NETWORKS.bitcoin!) * rate));
  const xs = { provider: 'thorchain' as const, toNetwork: 'ethereum', toAsset: 'native', minOut: fromThorAmount(aBtc.limit, 18).toString(), limit: aBtc.limit.toString(), memo: aBtc.memo, vault: VAULT_BTC, vaultPubKey: vaultKey.BTC, router: '', approveGas: '0' };
  const mk = (o: Partial<Intent> = {}, x: Partial<typeof xs> = {}): Intent => { const b = base('bitcoin', 'native', 'BTC', 8, amount, x.vault ?? VAULT_BTC); return IntentSchema.parse({ ...b, maxFee: fee.toString(),
    btc: { inputs: [{ txid: coin.txid, vout: coin.vout, value: coin.value.toString() }], change: (coin.value - amount - fee).toString(), fee: fee.toString() }, xswap: { ...xs, expiry: b.createdAt + 900, ...x }, ...o }); };
  const { i, out } = await signLive(() => mk());
  const tx = bitcoin.Transaction.fromHex(out.raw), vsize = tx.virtualSize();
  say(`  raw (${out.raw.length / 2} bytes, vsize ${vsize}): ${out.raw}`);
  say(`  txid ${out.txid} — NOT broadcast`);
  const o = tx.outs.map((x) => ({ script: Buffer.from(x.script), amount: BigInt(x.value) }));
  check(tx.getId() === out.txid, 'the transaction id is the hash of these bytes (bitcoinjs-lib)');
  check(tx.ins.length === 1 && Buffer.from(tx.ins[0]!.hash).reverse().toString('hex') === coin.txid && tx.ins[0]!.witness.length === 2, 'one input: the made-up coin, with a P2WPKH witness (signature + key)');
  check(tx.outs.length === 3, 'exactly three outputs');
  const addrOf = (k: number) => bitcoin.address.fromOutputScript(o[k]!.script, bitcoin.networks.bitcoin);
  check(addrOf(0) === VAULT_BTC && o[0]!.amount === amount, `output 0: ${formatUnits(o[0]!.amount!, 8)} BTC to the vault ${VAULT_BTC}`);
  check(addrOf(1) === ME.bitcoin && o[1]!.amount === coin.value - amount - fee && utxoPaymentTo(out.raw, 'bitcoin', VAULT_BTC).paid === amount, `output 1: change ${formatUnits(o[1]!.amount!, 8)} BTC back to the wallet ${ME.bitcoin}`);
  const d = bitcoin.script.decompile(o[2]!.script)!;
  check(o[2]!.amount === 0n && d.length === 2 && d[0] === bitcoin.opcodes.OP_RETURN && Buffer.from(d[1] as Uint8Array).toString('utf8') === aBtc.memo, `output 2: OP_RETURN ${o[2]!.script.toString('hex')} = "${aBtc.memo}" (${aBtc.memo.length} bytes ≤ 80)`);
  check(coin.value - o.reduce((s, x) => s + x.amount, 0n) === fee && BigInt(vsize) * BigInt(rate) <= fee, `fee ${fee} sat for ${vsize} vB at THORChain's recommended ${rate} sat/vB (≥ the rate; within the 5000 sat policy ceiling)`);
  check(parseThorMemo(aBtc.memo).destination === ME.ethereum, `memo destination is the wallet's own Ethereum address ${ME.ethereum}; limit ${aBtc.limit} (1e8) = ${formatUnits(fromThorAmount(aBtc.limit, 18), 18)} ETH minimum`);
  const j = store.state.journal.filter((r) => r.type === 'xswap.vault_confirmed').at(-1)!;
  check(!!j, `signer journal: vault confirmed by its own operators ${(j.data.operators as string[]).join(', ')} at height ${j.data.height}`);
  await refused('same proposal a second time', signer.sign(i, pk.assert(intentHash(i))), /already signed/);
  const sign = (x: Intent) => signer.sign(x, pk.assert(intentHash(x)));
  const evilKey = fakeKey(), evilAddr = thorVaultAddress(evilKey, 'bitcoin');
  await refused('compromised API: its own vault key and matching address', sign(mk({}, { vault: evilAddr, vaultPubKey: evilKey })), /not confirmed by the signer's THORNode operators/);
  await refused('compromised API: its own address under the genuine vault key', sign(mk({}, { vault: evilAddr })), /not the address of the committed vault key/);
  await refused('memo paying another address', sign(mk({}, { memo: buildThorMemo(thorAsset('ethereum', 'native'), '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', aBtc.limit) })), /memo does not match/);
  await refused('memo limit lowered to 1', sign(mk({}, { limit: '1', memo: buildThorMemo(thorAsset('ethereum', 'native'), ME.ethereum!, 1n) })), /below the approved minimum/);
  await refused('amount above the per-transfer limit', sign(mk({ amount: '80000', btc: { inputs: [{ txid: coin.txid, vout: 0, value: '150000' }], change: (150_000n - 80_000n - fee).toString(), fee: fee.toString() } })), /per-transaction limit/);
  await refused('approval made for another intent', signer.sign(mk(), pk.assert(intentHash(i))), /approval/);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
say('\n== Part 3 — Ethereum source on a local anvil fork (real THORChain Router bytecode) ==');
const PORT = 8557, FORK = `http://127.0.0.1:${PORT}`;
const anvil: ChildProcess = spawn('anvil', ['--fork-url', eth.rpc[0]!, '--port', String(PORT), '--silent', '--chain-id', '1'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill());
const f = <T,>(m: string, p: unknown[] = []) => rpc<T>(FORK, m, p);
try {
  for (let k = 0; ; k++) { try { await f('eth_chainId'); break; } catch { if (k > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); } }
  const mine = async (raw: string) => { const h = await f<string>('eth_sendRawTransaction', [raw]); for (let k = 0; k < 200; k++) { const rc = await f<any>('eth_getTransactionReceipt', [h]); if (rc) return rc; await new Promise((r) => setTimeout(r, 100)); } throw new Error('no receipt'); };
  const call = (to: string, data: Hex) => f<Hex>('eth_call', [{ to, data }, 'latest']);
  const allow = async () => hexToBigInt(await call(USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [ME.ethereum as Hex, ROUTER.address as Hex] })));
  const vaultUsdc = async () => hexToBigInt(await call(ROUTER.address, encodeFunctionData({ abi: THOR_ROUTER_ABI, functionName: 'vaultAllowance', args: [VAULT_ETH as Hex, USDC as Hex] })));
  check(sha(await f<string>('eth_getCode', [ROUTER.address, 'latest'])) === ROUTER.codeSha256, 'fork runs the pinned router bytecode');
  await f('anvil_setBalance', [ME.ethereum, numberToHex(10n ** 18n)]);
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ME.ethereum as Hex, 9n])); // FiatToken balances mapping
  await f('anvil_setStorageAt', [USDC, slot, numberToHex(100_000_000n, { size: 32 })]);
  const blk = await f<any>('eth_getBlockByNumber', ['latest', false]), maxFeePerGas = hexToBigInt(blk.baseFeePerGas) * 2n + 1_000_000_000n;
  let nonce = 0;
  const deposit = async (label: string, src: ThorAsset, amount: bigint, agreed: NonNullable<typeof aBtc>, needApprove: boolean) => {
    const gas = 120_000n, approveGas = needApprove ? 70_000n : 0n;
    const { i, out } = await signLive(() => { const b0 = base('ethereum', src.asset, src.symbol, src.decimals, amount, VAULT_ETH); return IntentSchema.parse({ ...b0, maxFee: ((gas + approveGas) * maxFeePerGas).toString(),
      evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '1000000000' },
      xswap: { provider: 'thorchain', toNetwork: 'bitcoin', toAsset: 'native', minOut: agreed.limit.toString(), limit: agreed.limit.toString(), memo: agreed.memo, vault: VAULT_ETH, vaultPubKey: vaultKey.ETH, router: ROUTER.address, expiry: b0.createdAt + 900, approveGas: approveGas.toString() } }); });
    const before = { vault: hexToBigInt(await f<Hex>('eth_getBalance', [VAULT_ETH, 'latest'])), usdc: await vaultUsdc() };
    if (out.pre) { const rc = await mine(out.pre.raw); check(rc.status === '0x1' && (await allow()) === amount, `${label}: approval mined, allowance of the router = exactly ${formatUnits(amount, src.decimals)} ${src.symbol}`); nonce += 1; }
    const rc = await mine(out.raw); nonce += 1;
    const ev = rc.logs.filter((l: any) => l.address.toLowerCase() === ROUTER.address.toLowerCase()).map((l: any) => decodeEventLog({ abi: THOR_ROUTER_ABI, data: l.data, topics: l.topics }))[0] as any;
    check(rc.status === '0x1' && rc.to.toLowerCase() === ROUTER.address.toLowerCase(), `${label}: router call mined on the fork (gas used ${Number(rc.gasUsed)})`);
    check(ev?.eventName === 'Deposit' && ev.args.to.toLowerCase() === VAULT_ETH.toLowerCase() && ev.args.amount === amount && ev.args.memo === agreed.memo && ev.args.asset.toLowerCase() === (src.asset === 'native' ? '0x' + '0'.repeat(40) : src.asset.toLowerCase()),
      `${label}: Deposit(to = ${ev?.args.to}, asset = ${ev?.args.asset}, amount = ${ev?.args.amount}, memo = "${ev?.args.memo}")`);
    if (src.asset === 'native') check(hexToBigInt(await f<Hex>('eth_getBalance', [VAULT_ETH, 'latest'])) - before.vault === amount, `${label}: the vault's ETH balance rose by exactly ${formatUnits(amount, 18)} ETH`);
    else check((await vaultUsdc()) - before.usdc === amount && (await allow()) === 0n, `${label}: router.vaultAllowance(vault, USDC) rose by exactly ${formatUnits(amount, 6)}; the wallet's allowance is back to 0`);
    return i;
  };
  const aEth = agreedFor.get('ethereum:native>bitcoin:native'), aUsdc = agreedFor.get(`ethereum:${USDC}>bitcoin:native`);
  if (aEth) await deposit('ETH -> BTC', thorAsset('ethereum', 'native'), 20_000_000_000_000_000n, aEth, false); else check(false, 'no agreed ETH -> BTC quote');
  if (aUsdc) {
    const last = await deposit('USDC -> BTC', thorAsset('ethereum', USDC), 45_000_000n, aUsdc, true);
    await refused('router call of a signer-built deposit after its expiry (time moved forward on the fork)', (async () => {
      await f('evm_increaseTime', [1000]); await f('evm_mine', []);
      const { xswapDepositData } = await import('@spw/core');
      await f('eth_call', [{ from: ME.ethereum, to: ROUTER.address, data: xswapDepositData(last, ME.bitcoin!) }, 'latest']);
    })(), /expired/);
  } else check(false, 'no agreed USDC -> BTC quote');
} finally { anvil.kill(); }

say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — nothing was broadcast to a real network; the THORChain side (observation, swap, outbound, refund) cannot be forked and was not exercised.`);
process.exit(failures === 0 ? 0 : 1);
