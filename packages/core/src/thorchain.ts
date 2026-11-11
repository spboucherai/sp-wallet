// Native cross-chain swaps through THORChain, wallet to itself only (docs/swap/providers/thorchain.md).
//
// A THORChain swap is ONE transfer of the source asset to the current Asgard vault of the source chain, carrying the memo
// `=:ASSET:DEST:LIMIT`. Nothing here comes from a provider: the memo and the transaction are built from the approved intent
// and the tables pinned in this file.
//
//   What the signer proves by itself, offline:
//     - the memo: handler `=`, exactly four fields, the asset spelling pinned here for a registry asset, DEST = the wallet's own
//       address on the destination chain, LIMIT a plain decimal integer (1e8 units) worth at least the approved minimum, no
//       refund override (a refund returns to the sender = the wallet), no streaming field, no affiliate;
//     - the transaction: UTXO = output 0 to the vault, output 1 change to the wallet, output 2 OP_RETURN(memo), nothing else;
//       Ethereum = the pinned THORChain Router's depositWithExpiry(vault, asset, amount, memo, expiry), exact-amount approval;
//     - that the vault ADDRESS is the address of the vault PUBLIC KEY the intent commits to (derived locally).
//   What cannot be proven offline: that this public key is a current Asgard vault. It is a threshold key of the node set, it
//   rotates at every churn and is only published by the network's nodes. The defence is checkThorVault() below: several
//   independently operated THORNodes are asked directly (by the signer itself, and by the API) and must ALL name the key as an
//   ActiveVault, on a chain that is not halted, at about the same block height. What remains trusted: collusion or simultaneous
//   compromise of every operator that answered (at least THOR_MIN_OPERATORS), TLS, and THORChain itself.
//
// Router v4.1 on Ethereum, verified source read 2026-11-11 (etherscan, solc 0.8.13, not a proxy):
//   depositWithExpiry requires block.timestamp < expiration, then deposit(): asset == 0 forwards msg.value to `vault`
//   (vault.send) and ignores `amount`; a token requires msg.value == 0, pulls exactly `amount` from msg.sender by transferFrom
//   into the router and credits it to `vault` (vaultAllowance); it emits Deposit(vault, asset, amount, memo). The vault is an
//   argument: the router does not know which vaults are genuine.
import { Address, OutScript, p2pkh, p2wpkh, Script, Transaction } from '@scure/btc-signer';
import { bech32, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { encodeFunctionData, erc20Abi, getAddress, keccak256, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { z } from 'zod';
import { baseUnits } from './amounts.ts';
import { normalizeAddress } from './address.ts';
import { btcParams, dustOf, estimateBtcVsize } from './build-btc.ts';
import { getAsset, getNetwork, NETWORKS, type NetworkDef } from './networks.ts';
import type { Intent } from './intent.ts';

// ───────────────────────────── pinned tables ─────────────────────────────

export interface ThorAsset {
  network: string; /** registry asset id ('native' or the contract as the registry spells it) */ asset: string; symbol: string; decimals: number;
  /** THORChain chain id and full pool notation */
  chain: string; notation: string;
  /** the spelling THORNode itself writes in the memo of a quote for this asset (pool short code, or CHAIN.TICKER for a token) */
  memo: string;
  /** may be the INPUT of a swap (a builder exists and was reviewed for this chain) */
  source: boolean;
}
/**
 * Assets that can be swapped. Every pool was `Available` on 2026-11-11 (the API re-reads the pools from two operators before
 * each swap; scripts/sim-thorchain.mts re-checks them). The contract in the notation must be a registry token of the network: resolved at load time, never by ticker.
 * A token's memo spelling `CHAIN.TICKER` is resolved by THORChain to the deepest pool with that chain and ticker; the four
 * tokens below are the only pools with their ticker on Ethereum, and the API refuses a swap if that ever changes.
 */
const PINNED: [network: string, notation: string, memo: string, source: boolean][] = [
  ['bitcoin', 'BTC.BTC', 'b', true],
  ['litecoin', 'LTC.LTC', 'l', true],
  // Dogecoin is a destination only: THORChain recommends 750 000 koinu per byte for an inbound (inbound_addresses, 2026-11-11),
  // far above the wallet's Dogecoin fee ceiling, which is not raised
  ['dogecoin', 'DOGE.DOGE', 'd', false],
  ['ethereum', 'ETH.ETH', 'e', true],
  ['ethereum', 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', 'ETH.USDC', true],
  ['ethereum', 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7', 'ETH.USDT', true],
  ['ethereum', 'ETH.DAI-0X6B175474E89094C44DA98B954EEDEAC495271D0F', 'ETH.DAI', true],
  ['ethereum', 'ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599', 'ETH.WBTC', true],
];
export const THOR_ASSETS: ThorAsset[] = PINNED.map(([network, notation, memo, source]) => {
  const n = NETWORKS[network]; if (!n) throw new Error(`THORChain table: unknown network ${network}`);
  const [chain, rest] = notation.split('.') as [string, string], dash = rest.indexOf('-');
  if (dash < 0) { if (n.native.symbol.toUpperCase() !== rest) throw new Error(`THORChain table: ${notation} is not the gas asset of ${network}`); return { network, asset: 'native', symbol: n.native.symbol, decimals: n.native.decimals, chain, notation, memo, source }; }
  const hits = n.tokens.filter((t) => t.id.toUpperCase() === rest.slice(dash + 1));
  if (hits.length !== 1 || hits[0]!.symbol.toUpperCase() !== rest.slice(0, dash)) throw new Error(`THORChain table: ${notation} is not a registry token of ${network}`);
  return { network, asset: hits[0]!.id, symbol: hits[0]!.symbol, decimals: hits[0]!.decimals, chain, notation, memo, source };
});
export function thorAsset(network: string, asset: string): ThorAsset {
  const a = THOR_ASSETS.find((x) => x.network === network && (x.asset === 'native' ? asset === 'native' : x.asset.toLowerCase() === asset.toLowerCase()));
  if (!a) throw new Error('this asset cannot be swapped through THORChain by this wallet');
  return a;
}
export const thorPairEnabled = (from: { network: string; asset: string }, to: { network: string; asset: string }): boolean => {
  try { return thorAsset(from.network, from.asset).source && !!thorAsset(to.network, to.asset) && from.network !== to.network; } catch { return false; }
};

/** THORChain Router per EVM source network: address named by the network on every operator, SHA-256 of its runtime bytecode on both registry RPCs. */
export const THOR_ROUTERS: Record<string, { address: string; codeSha256: string; reviewed: string }> = {
  ethereum: { address: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146', codeSha256: '2073bd2f5d34e2b610bc41d1b52ef0a8c3ec5000480c6f3e157dc486e1f02ea8',
    reviewed: '2026-11-11, verified source read in full on etherscan (THORChain_Router v4.1, solc 0.8.13, not a proxy); bytecode hashed on both registry RPCs; deposit proven on a fork' },
};
export const THOR_ROUTER_ABI = [
  { type: 'function', name: 'depositWithExpiry', stateMutability: 'payable', outputs: [], inputs: [{ name: 'vault', type: 'address' }, { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'memo', type: 'string' }, { name: 'expiration', type: 'uint256' }] },
  { type: 'function', name: 'vaultAllowance', stateMutability: 'view', outputs: [{ type: 'uint256' }], inputs: [{ name: 'vault', type: 'address' }, { name: 'token', type: 'address' }] },
  { type: 'event', name: 'Deposit', inputs: [{ name: 'to', type: 'address', indexed: true }, { name: 'asset', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'memo', type: 'string', indexed: false }] },
  { type: 'event', name: 'TransferOut', inputs: [{ name: 'vault', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'asset', type: 'address', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'memo', type: 'string', indexed: false }] },
] as const;

/**
 * Independently operated public THORNode APIs (2026-11-11). The first three are published by THORChain's documentation and
 * the Cosmos chain registry; the last two are the public nodes of two wallets. This list is compiled into the signer: the API
 * cannot change which operators the signer asks.
 */
export const THORNODE_OPERATORS: { id: string; base: string }[] = [
  { id: 'liquify', base: 'https://gateway.liquify.com/chain/thorchain_api' },
  { id: 'rorcual', base: 'https://api-thorchain.rorcual.xyz' },
  { id: 'ibs', base: 'https://thorchain.ibs.team/api' },
  { id: 'thorwallet', base: 'https://thornode.thorwallet.org' },
  { id: 'keplr', base: 'https://lcd-thorchain.keplr.app' },
];
/** Fewer answers than this = no signature. With five pinned operators, two may be down. */
export const THOR_MIN_OPERATORS = 3;
/** Operators must be within this many THORChain blocks of each other (6 s blocks: five minutes). */
export const THOR_MAX_HEIGHT_SPREAD = 50;
/** The router call reverts after this many seconds; a UTXO inbound is never (re)broadcast after it. */
export const THOR_EXPIRY_SECONDS = 900;

// ───────────────────────────── 1e8 units ─────────────────────────────

const pow10 = (n: number) => 10n ** BigInt(n);
/** Base units → THORChain 1e8 units. Throws when the amount has a part below 1e-8 that THORChain would not credit. */
export function toThorAmount(base: bigint, decimals: number): bigint {
  if (base < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('bad amount');
  if (decimals <= 8) return base * pow10(8 - decimals);
  if (base % pow10(decimals - 8) !== 0n) throw new Error('amount is finer than THORChain\'s 8 decimals');
  return base / pow10(decimals - 8);
}
/** THORChain 1e8 units → base units, rounded DOWN (a chain cannot pay a fraction of its base unit). */
export function fromThorAmount(units: bigint, decimals: number): bigint {
  if (units < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('bad amount');
  return decimals >= 8 ? units * pow10(decimals - 8) : units / pow10(8 - decimals);
}

// ───────────────────────────── memo ─────────────────────────────

const LIMIT = /^[1-9]\d{0,24}$/; // plain decimal: no sign, no leading zero, no exponent ("1e6" would be accepted by THORChain and is refused here)
export const THOR_MEMO_MAX = 250, THOR_MEMO_MAX_UTXO = 80;
export interface ThorMemo { asset: ThorAsset; destination: string; limit: bigint }

/** `=:ASSET:DEST:LIMIT` for a pinned asset. The limit is written in full: nothing is rounded or shortened. */
export function buildThorMemo(to: ThorAsset, destination: string, limit: bigint): string {
  if (limit <= 0n || !LIMIT.test(limit.toString())) throw new Error('memo limit must be a positive integer');
  if (normalizeAddress(to.network, destination) !== destination) throw new Error('memo destination is not a normalized address of the destination network');
  if (!/^[A-Za-z0-9]{20,100}$/.test(destination)) throw new Error('memo destination has characters a memo cannot carry');
  const memo = `=:${to.memo}:${destination}:${limit}`;
  if (memo.length > THOR_MEMO_MAX) throw new Error('memo too long');
  return memo;
}
/** Strict inverse of buildThorMemo. Anything this wallet never writes — another handler, a refund override, streaming or
 *  affiliate fields, scientific notation, an asset spelling that is not pinned — is refused. */
export function parseThorMemo(memo: string): ThorMemo {
  if (typeof memo !== 'string' || memo.length > THOR_MEMO_MAX || !/^[\x21-\x7e]+$/.test(memo)) throw new Error('memo is not printable ASCII of an acceptable length');
  const p = memo.split(':');
  if (p[0] !== '=') throw new Error('memo is not a market swap');
  if (p.length !== 4) throw new Error(p.length > 4 ? 'memo carries affiliate or extra fields' : 'memo has no limit');
  const [, a, dest, lim] = p as [string, string, string, string];
  if (dest.includes('/')) throw new Error('memo carries a refund address override');
  if (lim.includes('/')) throw new Error('memo carries streaming parameters');
  if (!LIMIT.test(lim)) throw new Error('memo limit is not a plain positive integer');
  const asset = THOR_ASSETS.find((x) => x.memo === a);
  if (!asset) throw new Error('memo names an asset spelling that is not pinned');
  if (!/^[A-Za-z0-9]{20,100}$/.test(dest)) throw new Error('memo destination is malformed');
  try { if (normalizeAddress(asset.network, dest) !== dest) throw new Error('x'); } catch { throw new Error('memo destination is not a normalized address of the destination network'); }
  return { asset, destination: dest, limit: BigInt(lim) };
}

// ───────────────────────────── vault key → address ─────────────────────────────

const AMINO_SECP = 'eb5ae98721';
/** The 33-byte secp256k1 key inside a `thorpub1addwnpep…` string (bech32 of the amino-prefixed compressed key). */
export function thorPubKeyBytes(pubKey: string): Uint8Array {
  if (typeof pubKey !== 'string' || !/^thorpub1[02-9ac-hj-np-z]{50,80}$/.test(pubKey)) throw new Error('not a THORChain public key');
  const d = bech32.decodeToBytes(pubKey);
  if (d.prefix !== 'thorpub' || d.bytes.length !== 38 || hex.encode(d.bytes.slice(0, 5)) !== AMINO_SECP) throw new Error('not a secp256k1 THORChain public key');
  const key = d.bytes.slice(5);
  secp256k1.Point.fromBytes(key); // must be a point of the curve
  return key;
}
/** Inverse of thorPubKeyBytes (tests and the proof script build keys no node knows with it). */
export function encodeThorPubKey(key: Uint8Array): string {
  if (key.length !== 33) throw new Error('not a compressed key');
  return bech32.encode('thorpub', bech32.toWords(new Uint8Array([...hex.decode(AMINO_SECP), ...key])), 200);
}
/** The address a vault key controls on a wallet network (native SegWit / legacy P2PKH for Bitcoin-style chains, the usual keccak address for EVM). */
export function thorVaultAddress(pubKey: string, network: string): string {
  const n = getNetwork(network), key = thorPubKeyBytes(pubKey);
  if (n.family === 'evm') return getAddress(`0x${keccak256(secp256k1.Point.fromBytes(key).toBytes(false).slice(1)).slice(-40)}`);
  if (n.family === 'btc' && n.utxo) { const a = (n.utxo.kind === 'pkh' ? p2pkh(key, btcParams(n)) : p2wpkh(key, btcParams(n))).address; if (a) return a; }
  throw new Error('no vault address derivation for this network');
}

// ───────────────────────────── the vault check (shared by the signer and the API) ─────────────────────────────

const digits = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const InboundSchema = z.array(z.looseObject({ chain: z.string().regex(/^[A-Z0-9]{2,10}$/), pub_key: z.string().max(120), address: z.string().min(20).max(160), router: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  halted: z.boolean(), global_trading_paused: z.boolean().optional(), chain_trading_paused: z.boolean().optional(), gas_rate: digits.optional(), dust_threshold: digits.optional(), outbound_fee: digits.optional() })).min(1).max(100);
const VaultsSchema = z.array(z.looseObject({ pub_key: z.string().max(120), status: z.string().max(40), status_since: z.number().int().nonnegative().optional(), chains: z.array(z.string().max(12)).max(60).optional(),
  membership: z.array(z.string().max(120)).max(200).optional() })).min(1).max(60);
const LastBlockSchema = z.array(z.looseObject({ chain: z.string().max(12), thorchain: z.number().int().positive() })).min(1).max(100);

export interface ThorView {
  /** THORChain block height the node is at */
  height: number;
  inbound: { chain: string; pubKey: string; address: string; router: string | null; halted: boolean; paused: boolean; gasRate: bigint | null; dustThreshold: bigint; outboundFee: bigint | null }[];
  vaults: { pubKey: string; status: string; statusSince: number; chains: string[]; members: number }[];
}
export type ThorAnswer = { operator: string; view: ThorView } | { operator: string; error: string };
export type ThorGet = (url: string) => Promise<unknown>;

/** One operator's view: `inbound_addresses`, the Asgard vault set and the node's height. Throws on any malformed answer. */
export async function fetchThorView(base: string, get: ThorGet): Promise<ThorView> {
  const [inb, vaults, last] = await Promise.all([get(`${base}/thorchain/inbound_addresses`), get(`${base}/thorchain/vaults/asgard`), get(`${base}/thorchain/lastblock`)]);
  const i = InboundSchema.parse(inb), v = VaultsSchema.parse(vaults), l = LastBlockSchema.parse(last);
  return {
    height: Math.max(...l.map((x) => x.thorchain)),
    inbound: i.map((x) => ({ chain: x.chain, pubKey: x.pub_key, address: x.address, router: x.router ?? null, halted: x.halted, paused: !!x.global_trading_paused || !!x.chain_trading_paused,
      gasRate: x.gas_rate !== undefined ? BigInt(x.gas_rate) : null, dustThreshold: BigInt(x.dust_threshold ?? '0'), outboundFee: x.outbound_fee !== undefined ? BigInt(x.outbound_fee) : null })),
    vaults: v.map((x) => ({ pubKey: x.pub_key, status: x.status, statusSince: x.status_since ?? 0, chains: x.chains ?? [], members: x.membership?.length ?? 0 })),
  };
}
/** Ask every operator at once; an operator that fails or answers nonsense is reported, not retried. */
export async function fetchThorViews(get: ThorGet, operators = THORNODE_OPERATORS): Promise<ThorAnswer[]> {
  return Promise.all(operators.map(async (o): Promise<ThorAnswer> => {
    try { return { operator: o.id, view: await fetchThorView(o.base, get) }; } catch (e) { return { operator: o.id, error: (e as Error).message.slice(0, 120) || 'no answer' }; }
  }));
}

export interface ThorVaultWant { /** THORChain chain id of the source */ chain: string; vaultPubKey: string; /** pinned router of the source network, or null for a chain without router */ router: string | null; /** what is sent, 1e8 units */ amount: bigint }
export interface ThorVaultVerdict { operators: string[]; silent: string[]; height: number; /** height at which the vault became active (its churn) */ statusSince: number; /** highest values named by any operator */ gasRate: bigint | null; dustThreshold: bigint; outboundFee: bigint | null; members: number }

/**
 * The unanimity rule. Throws unless at least `min` distinct operators answered and EVERY operator that answered
 *   - is within THOR_MAX_HEIGHT_SPREAD blocks of the others (a lagging node does not know the last churn);
 *   - lists the vault key as an `ActiveVault` serving the chain, with the same churn height;
 *   - reports the chain neither halted nor paused, and (EVM) the pinned router;
 *   - reports a dust threshold below the amount.
 * One dissenting answer is enough to refuse: an honest operator that disagrees is exactly the signal this check exists for.
 * Operators that did not answer are tolerated only while `min` others did.
 */
export function checkThorVault(answers: ThorAnswer[], want: ThorVaultWant, min = THOR_MIN_OPERATORS): ThorVaultVerdict {
  const seen = new Set<string>(), views: { operator: string; view: ThorView }[] = [], silent: string[] = [];
  for (const a of answers) {
    if (seen.has(a.operator)) throw new Error('an operator was counted twice');
    seen.add(a.operator);
    if ('view' in a) views.push(a); else silent.push(a.operator);
  }
  if (views.length < Math.max(min, THOR_MIN_OPERATORS)) throw new Error(`only ${views.length} THORNode operator(s) answered, ${Math.max(min, THOR_MIN_OPERATORS)} are required${silent.length ? ` (silent: ${silent.join(', ')})` : ''}`);
  const heights = views.map((v) => v.view.height), top = Math.max(...heights);
  let statusSince = -1, gasRate: bigint | null = null, dust = 0n, outboundFee: bigint | null = null, members = 0;
  for (const { operator, view } of views) {
    const no = (why: string): never => { throw new Error(`THORNode operator ${operator} ${why}; the vault is not confirmed`); };
    if (top - view.height > THOR_MAX_HEIGHT_SPREAD) no(`is ${top - view.height} blocks behind the others`);
    const hits = view.vaults.filter((v) => v.pubKey === want.vaultPubKey);
    if (hits.length !== 1) no('does not list this vault');
    const v = hits[0]!;
    if (v.status !== 'ActiveVault') no(`lists this vault as ${v.status.slice(0, 20)}`);
    if (!v.chains.includes(want.chain)) no(`lists this vault without ${want.chain}`);
    if (statusSince === -1) statusSince = v.statusSince; else if (v.statusSince !== statusSince) no('gives another churn height for this vault');
    const inb = view.inbound.filter((x) => x.chain === want.chain);
    if (inb.length !== 1) no(`has no inbound address for ${want.chain}`);
    const e = inb[0]!;
    if (e.halted) no(`reports ${want.chain} halted`);
    if (e.paused) no(`reports trading paused on ${want.chain}`);
    if (want.router === null ? e.router !== null : !e.router || e.router.toLowerCase() !== want.router.toLowerCase()) no('names another router');
    if (want.amount <= e.dustThreshold) no('reports a dust threshold at or above the amount');
    if (e.gasRate !== null && (gasRate === null || e.gasRate > gasRate)) gasRate = e.gasRate;
    if (e.dustThreshold > dust) dust = e.dustThreshold;
    if (e.outboundFee !== null && (outboundFee === null || e.outboundFee > outboundFee)) outboundFee = e.outboundFee;
    if (members === 0 || v.members < members) members = v.members;
  }
  return { operators: views.map((v) => v.operator), silent, height: top, statusSince, gasRate, dustThreshold: dust, outboundFee, members };
}
/** The vault key the most operators currently name as the inbound address of a chain (ties: the first in operator order). */
export function pickThorVault(answers: ThorAnswer[], chain: string): string | null {
  const votes = new Map<string, number>();
  for (const a of answers) if ('view' in a) for (const x of a.view.inbound) if (x.chain === chain) votes.set(x.pubKey, (votes.get(x.pubKey) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [k, v] of votes) if (v > n) { best = k; n = v; }
  return best;
}

// ───────────────────────────── the intent ─────────────────────────────

export interface XswapPlan { src: ThorAsset; dst: ThorAsset; amount: bigint; amount1e8: bigint; limit: bigint; minOut: bigint; memo: string; want: ThorVaultWant }

/** Check every field of a cross-chain swap intent. `ownDestination` is the wallet's address on the destination network, as
 *  the caller derives it (the signer from its keys). Throws on any mismatch. */
export function verifyXswap(i: Intent, ownDestination: string): XswapPlan {
  const n = getNetwork(i.network), x = i.xswap;
  if (!x) throw new Error('not a cross-chain swap intent');
  if (i.swap || i.bridge) throw new Error('an intent is one operation only');
  if (x.provider !== 'thorchain') throw new Error('unknown cross-chain provider');
  if (i.chainRef !== n.chainRef) throw new Error('chain identity mismatch');
  if (i.memo !== undefined) throw new Error('a cross-chain swap carries its memo in the swap section only');
  const src = thorAsset(i.network, i.asset), dst = thorAsset(x.toNetwork, x.toAsset);
  if (!src.source) throw new Error(`${src.symbol} on ${n.name} cannot be the input of a THORChain swap in this wallet`);
  if (src.network === dst.network) throw new Error('source and destination are the same network');
  const reg = getAsset(i.network, i.asset); // throws unless in the registry
  if (i.asset !== src.asset || reg.symbol !== i.symbol || reg.decimals !== i.decimals || src.decimals !== i.decimals) throw new Error('input asset metadata mismatch');
  if (x.toAsset !== dst.asset || getAsset(x.toNetwork, x.toAsset).decimals !== dst.decimals) throw new Error('output asset metadata mismatch');
  if (!ownDestination || normalizeAddress(x.toNetwork, ownDestination) !== ownDestination) throw new Error('no wallet address on the destination network');
  const amount = baseUnits(i.amount), limit = baseUnits(x.limit), minOut = baseUnits(x.minOut);
  if (amount <= 0n || limit <= 0n || minOut <= 0n) throw new Error('amounts must be positive');
  const amount1e8 = toThorAmount(amount, src.decimals);
  if (amount1e8 <= 0n) throw new Error('amount below THORChain precision');
  if (fromThorAmount(limit, dst.decimals) < minOut) throw new Error('memo limit is below the approved minimum');
  const memo = buildThorMemo(dst, ownDestination, limit);
  if (memo !== x.memo) throw new Error('memo does not match what this wallet builds for the approved swap');
  const back = parseThorMemo(memo);
  if (back.asset !== dst || back.destination !== ownDestination || back.limit !== limit) throw new Error('memo does not read back as the approved swap');
  if (new TextEncoder().encode(memo).length > (n.family === 'btc' ? THOR_MEMO_MAX_UTXO : THOR_MEMO_MAX)) throw new Error('memo too long for the source chain');
  // the vault address must be the address of the committed vault key, and never the wallet itself
  if (i.to !== x.vault) throw new Error('the transfer does not go to the committed vault');
  if (thorVaultAddress(x.vaultPubKey, i.network) !== x.vault) throw new Error('vault address is not the address of the committed vault key');
  if (x.vault.toLowerCase() === i.from.toLowerCase()) throw new Error('vault is the wallet itself');
  let router: string | null = null;
  if (n.family === 'evm') {
    const pin = THOR_ROUTERS[i.network];
    if (!pin) throw new Error(`THORChain swaps from ${n.name} are not enabled`);
    if (x.router !== pin.address) throw new Error('router is not the pinned THORChain router');
    if (x.vault.toLowerCase() === pin.address.toLowerCase()) throw new Error('vault is the router');
    router = pin.address;
  } else if (n.family === 'btc') {
    if (x.router !== '' || x.approveGas !== '0') throw new Error('a UTXO swap has no router and no approval');
  } else throw new Error('THORChain swaps are not defined for this network family');
  if (!(x.expiry > i.expiresAt) || x.expiry > i.createdAt + THOR_EXPIRY_SECONDS) throw new Error('swap expiry outside the allowed window');
  return { src, dst, amount, amount1e8, limit, minOut, memo, want: { chain: src.chain, vaultPubKey: x.vaultPubKey, router, amount: amount1e8 } };
}

// ───────────────────────────── source transactions ─────────────────────────────

const DEPOSIT_GAS_MIN = 30_000n, DEPOSIT_GAS_MAX = 400_000n, APPROVE_GAS_MAX = 120_000n, ZERO = '0x0000000000000000000000000000000000000000';

export function xswapDepositData(i: Intent, ownDestination: string): Hex {
  const p = verifyXswap(i, ownDestination), x = i.xswap!;
  return encodeFunctionData({ abi: THOR_ROUTER_ABI, functionName: 'depositWithExpiry', args: [x.vault as Hex, (p.src.asset === 'native' ? ZERO : p.src.asset) as Hex, p.amount, p.memo, BigInt(x.expiry)] });
}
/** Ethereum source: an exact-amount approval when asked (tokens only), then the router deposit. */
export function buildXswapEvmTxs(i: Intent, ownDestination: string): { approve: TransactionSerializableEIP1559 | null; deposit: TransactionSerializableEIP1559 } {
  const p = verifyXswap(i, ownDestination), n = getNetwork(i.network), e = i.evm, x = i.xswap!;
  if (n.family !== 'evm' || !e) throw new Error('not an EVM intent');
  const gas = baseUnits(e.gasLimit), maxFeePerGas = baseUnits(e.maxFeePerGas), tip = baseUnits(e.maxPriorityFeePerGas), approveGas = baseUnits(x.approveGas);
  if (tip > maxFeePerGas) throw new Error('priority fee above max fee');
  if (gas < DEPOSIT_GAS_MIN || gas > DEPOSIT_GAS_MAX) throw new Error('deposit gas limit out of range');
  if (approveGas !== 0n && (p.src.asset === 'native' || approveGas < 30_000n || approveGas > APPROVE_GAS_MAX)) throw new Error('approval gas out of range');
  if ((gas + approveGas) * maxFeePerGas > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const common = { type: 'eip1559' as const, chainId: Number(n.chainRef), maxFeePerGas, maxPriorityFeePerGas: tip };
  const approve = approveGas === 0n ? null : { ...common, nonce: e.nonce, gas: approveGas, to: p.src.asset as Hex, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [x.router as Hex, p.amount] }) }; // exact amount, never unlimited
  const deposit = { ...common, nonce: e.nonce + (approve ? 1 : 0), gas, to: x.router as Hex, value: p.src.asset === 'native' ? p.amount : 0n, data: xswapDepositData(i, ownDestination) };
  return { approve, deposit };
}

/** The OP_RETURN script of a memo (one data push). */
export function thorOpReturn(memo: string): Uint8Array {
  const b = new TextEncoder().encode(memo);
  if (b.length < 1 || b.length > THOR_MEMO_MAX_UTXO) throw new Error('memo does not fit in OP_RETURN');
  return Script.encode(['RETURN', b]);
}
/** Bytes the OP_RETURN output adds to a transaction: value (8) + script length (1) + script. */
export const thorOpReturnSize = (memo: string) => 9 + thorOpReturn(memo).length;
/** Upper bound of the virtual size of a swap transaction: inputs, vault output, change output, OP_RETURN. */
export const estimateXswapVsize = (nInputs: number, vault: string, memo: string, n: NetworkDef) => estimateBtcVsize(nInputs, vault, true, n) + thorOpReturnSize(memo);

/**
 * Bitcoin-style source: exactly three outputs, in the order THORChain requires — the vault, the change back to the wallet
 * (the address of input 0, where a refund would return), the memo. All inputs are the wallet's own coins.
 */
export function buildXswapBtcTx(i: Intent, ownDestination: string, aux?: Record<string, unknown>): Transaction {
  const p = verifyXswap(i, ownDestination), n = getNetwork(i.network);
  if (n.family !== 'btc' || !n.utxo || !i.btc) throw new Error('not a UTXO intent');
  const P = btcParams(n), DUST = dustOf(n);
  if (normalizeAddress(i.network, i.to) !== i.to) throw new Error('vault address not normalized');
  const fromDecoded = Address(P).decode(i.from);
  if (fromDecoded.type !== n.utxo.kind) throw new Error(n.utxo.kind === 'wpkh' ? 'source must be native SegWit (P2WPKH)' : 'source must be P2PKH');
  if (Address(P).decode(i.to).type !== n.utxo.kind) throw new Error('vault address is not of the expected script type');
  const script = OutScript.encode(fromDecoded);
  const change = baseUnits(i.btc.change), fee = baseUnits(i.btc.fee);
  if (p.amount < DUST) throw new Error('amount below dust');
  if (change < DUST) throw new Error('a swap transaction always returns change to the wallet (change below dust)');
  if (fee <= 0n || fee > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const prev = (aux?.prevTx ?? {}) as Record<string, string>, seen = new Set<string>();
  let total = 0n;
  const tx = new Transaction({ allowUnknownOutputs: true });
  for (const u of i.btc.inputs) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) throw new Error('duplicate input');
    seen.add(k);
    const v = baseUnits(u.value);
    total += v;
    if (n.utxo.kind === 'wpkh') tx.addInput({ txid: hex.decode(u.txid), index: u.vout, witnessUtxo: { script, amount: v }, sequence: 0xfffffffd });
    else { // legacy signatures do not commit to the input value: the previous transaction is checked against txid, script and value
      const raw = prev[u.txid];
      if (!raw) throw new Error('missing previous transaction for a legacy input');
      const pt = Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
      if (pt.id !== u.txid) throw new Error('previous transaction does not match input txid');
      const o = pt.getOutput(u.vout);
      if (o.amount !== v || !o.script || hex.encode(o.script) !== hex.encode(script)) throw new Error('previous output does not match the approved input');
      tx.addInput({ txid: hex.decode(u.txid), index: u.vout, nonWitnessUtxo: hex.decode(raw), sequence: 0xfffffffd });
    }
  }
  if (total !== p.amount + change + fee) throw new Error('inputs != outputs + fee');
  tx.addOutputAddress(i.to, p.amount, P);
  tx.addOutputAddress(i.from, change, P);
  tx.addOutput({ script: thorOpReturn(p.memo), amount: 0n });
  if (tx.outputsLength !== 3) throw new Error('unexpected output count');
  return tx;
}

/**
 * What a Bitcoin-style transaction pays to an address, and the memo it carries. Used to check, with the wallet's own data
 * sources, the outbound transaction THORChain names: the bytes are hashed here, so the answer is about that txid and nothing else.
 */
export function utxoPaymentTo(rawHex: string, network: string, address: string): { txid: string; paid: bigint; memo: string | null } {
  const n = getNetwork(network);
  if (n.family !== 'btc' || !n.utxo) throw new Error('not a UTXO network');
  const tx = Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const want = hex.encode(OutScript.encode(Address(btcParams(n)).decode(address)));
  let paid = 0n, memo: string | null = null;
  for (let k = 0; k < tx.outputsLength; k++) {
    const o = tx.getOutput(k);
    if (!o.script) continue;
    if (hex.encode(o.script) === want) paid += o.amount ?? 0n;
    else if (o.script[0] === 0x6a && memo === null) { try { const d = Script.decode(o.script); if (d.length === 2 && d[1] instanceof Uint8Array) memo = new TextDecoder().decode(d[1]); } catch { /* not a single push */ } }
  }
  return { txid: tx.id, paid, memo };
}

/** The transaction id as THORChain spells it (upper-case hex, no 0x). */
export const thorTxId = (txid: string) => txid.replace(/^0x/, '').toUpperCase();
