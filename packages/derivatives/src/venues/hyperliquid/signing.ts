// Hyperliquid signing library — pure: no network, no key storage. It produces hashes and EIP-712 typed data; the signature itself
// is made elsewhere (the isolated signer), and comes back as { r, s, v }.
// Ported from the official Python SDK, hyperliquid/utils/signing.py (master 2fdb18f, 2026-06-04), and proven against its test
// vectors (tests/signing_test.py) in test/hyperliquid/signing.test.ts.
//
// Two schemes (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing):
//  1. L1 actions (order, cancel, cancelByCloid, updateLeverage …): keccak256(msgpack(action) ‖ nonce u64 BE ‖ vault flag
//     [‖ vault address] [‖ 0x00 ‖ expiresAfter u64 BE]) is signed as the `connectionId` of a "phantom agent"
//     (EIP-712 domain `Exchange`, chainId 1337; source 'a' = mainnet, 'b' = testnet). An API wallet can sign these.
//  2. User-signed actions (approveAgent, usdClassTransfer, withdraw3 …): EIP-712 over the action's own fields, domain
//     `HyperliquidSignTransaction` with the chain id in `signatureChainId`; `hyperliquidChain` ('Mainnet' | 'Testnet') prevents
//     replay on the other network. Signed by the account's own key.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import { msgpackEncode, type MsgpackValue } from './msgpack.ts';

export type HlNetwork = 'mainnet' | 'testnet';
export interface HlSignature { r: Hex; s: Hex; v: number }
export interface HlTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, string | number | boolean>;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const EIP712_DOMAIN = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const u64 = (n: number, what: string): Uint8Array => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} must be a non-negative safe integer`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
};
/** addresses are signed and sent in lower case ("Issues with upper case characters in address fields" — signing page) */
export function hlAddress(a: string): Hex {
  const l = String(a).toLowerCase();
  if (!ADDRESS.test(l)) throw new Error('not a 20-byte hex address');
  return l as Hex;
}

/** The bytes the venue hashes for an L1 action. Field order of `action` is significant. */
export function l1ActionBytes(action: MsgpackValue, vaultAddress: string | null, nonce: number, expiresAfter: number | null): Uint8Array {
  const parts: Uint8Array[] = [msgpackEncode(action), u64(nonce, 'nonce')];
  if (vaultAddress === null) parts.push(Uint8Array.of(0));
  else {
    const v = hlAddress(vaultAddress).slice(2);
    parts.push(Uint8Array.of(1), Uint8Array.from({ length: 20 }, (_, i) => parseInt(v.slice(2 * i, 2 * i + 2), 16)));
  }
  if (expiresAfter !== null) parts.push(Uint8Array.of(0), u64(expiresAfter, 'expiresAfter'));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** `action_hash` of the SDK: the phantom agent's connectionId. */
export function l1ActionHash(action: MsgpackValue, vaultAddress: string | null, nonce: number, expiresAfter: number | null): Hex {
  return toHex(keccak_256(l1ActionBytes(action, vaultAddress, nonce, expiresAfter)));
}

/** EIP-712 typed data of the phantom agent (`l1_payload` of the SDK). */
export function l1TypedData(connectionId: Hex, network: HlNetwork): HlTypedData {
  if (!/^0x[0-9a-f]{64}$/.test(connectionId)) throw new Error('connectionId must be a 32-byte lower-case hex string');
  return {
    domain: { chainId: 1337, name: 'Exchange', verifyingContract: ZERO_ADDRESS, version: '1' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }], EIP712Domain: EIP712_DOMAIN },
    primaryType: 'Agent',
    message: { source: network === 'mainnet' ? 'a' : 'b', connectionId },
  };
}

/** Typed data to sign for an L1 action, in one call. */
export function l1SignPayload(action: MsgpackValue, o: { network: HlNetwork; nonce: number; vaultAddress?: string | null; expiresAfter?: number | null }): { connectionId: Hex; typedData: HlTypedData } {
  const connectionId = l1ActionHash(action, o.vaultAddress ?? null, o.nonce, o.expiresAfter ?? null);
  return { connectionId, typedData: l1TypedData(connectionId, o.network) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// User-signed actions

/** SDK default (`sign_user_signed_action`): "signatureChainId is the chain used by the wallet to sign and can be any chain". */
export const HL_DEFAULT_SIGNATURE_CHAIN_ID = '0x66eee';
export const hlChainName = (network: HlNetwork): 'Mainnet' | 'Testnet' => (network === 'mainnet' ? 'Mainnet' : 'Testnet');

type Field = { name: string; type: string };
export const HL_APPROVE_AGENT_TYPES: Field[] = [
  { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' },
];
export const HL_USD_CLASS_TRANSFER_TYPES: Field[] = [
  { name: 'hyperliquidChain', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'toPerp', type: 'bool' }, { name: 'nonce', type: 'uint64' },
];
export const HL_WITHDRAW_TYPES: Field[] = [
  { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' },
];
export const HL_USD_SEND_TYPES: Field[] = HL_WITHDRAW_TYPES.map((f) => ({ ...f }));
export const HL_PRIMARY = {
  approveAgent: 'HyperliquidTransaction:ApproveAgent',
  usdClassTransfer: 'HyperliquidTransaction:UsdClassTransfer',
  withdraw: 'HyperliquidTransaction:Withdraw',
  usdSend: 'HyperliquidTransaction:UsdSend',
} as const;

function chainIdOf(signatureChainId: string): number {
  if (!/^0x[0-9a-f]{1,12}$/.test(signatureChainId)) throw new Error('signatureChainId must be lower-case hex, e.g. 0x66eee');
  return parseInt(signatureChainId, 16);
}

/** `user_signed_payload` of the SDK. `message` must hold exactly the fields listed in `fields` (nothing else is signed). */
export function userSignedTypedData(primaryType: string, fields: Field[], message: Record<string, string | number | boolean>, signatureChainId: string): HlTypedData {
  const names = fields.map((f) => f.name);
  if (Object.keys(message).length !== names.length || names.some((n) => !(n in message))) throw new Error(`${primaryType}: message must hold exactly ${names.join(', ')}`);
  const ordered: Record<string, string | number | boolean> = {};
  for (const n of names) ordered[n] = message[n]!;
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: chainIdOf(signatureChainId), verifyingContract: ZERO_ADDRESS },
    types: { [primaryType]: fields.map((f) => ({ ...f })), EIP712Domain: EIP712_DOMAIN },
    primaryType,
    message: ordered,
  };
}

/** A decimal amount of USD as the venue wants it in a user-signed action: a plain decimal string. */
function usdAmount(amount: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) throw new Error('amount must be a positive decimal string with at most 6 decimals');
  return amount;
}

export interface HlUserSigned<A> { action: A; typedData: HlTypedData }

export interface HlApproveAgentAction { type: 'approveAgent'; hyperliquidChain: 'Mainnet' | 'Testnet'; signatureChainId: string; agentAddress: Hex; agentName?: string; nonce: number }
/** agent names: the docs allow an optional name and an expiry appended as " valid_until <ms timestamp>" */
export const HL_AGENT_NAME = /^[A-Za-z0-9_-]{1,16}( valid_until \d{13})?$/;
/**
 * approveAgent — authorizes an API wallet ("agent") to sign L1 actions for the account. Signed by the ACCOUNT key (never by the
 * agent). `agentName: null` registers the single unnamed agent (replacing the previous unnamed one); a name replaces the agent of
 * the same name. As in the SDK, the unnamed form signs `agentName: ""` and omits the field from the action that is sent.
 */
export function buildApproveAgent(o: { network: HlNetwork; agentAddress: string; agentName: string | null; nonce: number; signatureChainId?: string }): HlUserSigned<HlApproveAgentAction> {
  const signatureChainId = o.signatureChainId ?? HL_DEFAULT_SIGNATURE_CHAIN_ID;
  if (o.agentName !== null && !HL_AGENT_NAME.test(o.agentName)) throw new Error('agent name: 1–16 letters, digits, dash or underscore, optionally followed by " valid_until <ms>"');
  const agentAddress = hlAddress(o.agentAddress), hyperliquidChain = hlChainName(o.network);
  u64(o.nonce, 'nonce');
  const typedData = userSignedTypedData(HL_PRIMARY.approveAgent, HL_APPROVE_AGENT_TYPES, { hyperliquidChain, agentAddress, agentName: o.agentName ?? '', nonce: o.nonce }, signatureChainId);
  const action: HlApproveAgentAction = { type: 'approveAgent', hyperliquidChain, signatureChainId, agentAddress, ...(o.agentName !== null ? { agentName: o.agentName } : {}), nonce: o.nonce };
  return { action, typedData };
}

export interface HlUsdClassTransferAction { type: 'usdClassTransfer'; hyperliquidChain: 'Mainnet' | 'Testnet'; signatureChainId: string; amount: string; toPerp: boolean; nonce: number }
/**
 * DATA BUILDER ONLY — NOT WIRED TO ANYTHING. Typed data of a spot ⇄ perp USDC transfer inside the same account.
 * Moves funds; must only ever be signed by the account key after an explicit owner decision.
 */
export function buildUsdClassTransferTypedDataOnly(o: { network: HlNetwork; amount: string; toPerp: boolean; nonce: number; signatureChainId?: string }): HlUserSigned<HlUsdClassTransferAction> {
  const signatureChainId = o.signatureChainId ?? HL_DEFAULT_SIGNATURE_CHAIN_ID, hyperliquidChain = hlChainName(o.network), amount = usdAmount(o.amount);
  u64(o.nonce, 'nonce');
  const typedData = userSignedTypedData(HL_PRIMARY.usdClassTransfer, HL_USD_CLASS_TRANSFER_TYPES, { hyperliquidChain, amount, toPerp: o.toPerp, nonce: o.nonce }, signatureChainId);
  return { action: { type: 'usdClassTransfer', hyperliquidChain, signatureChainId, amount, toPerp: o.toPerp, nonce: o.nonce }, typedData };
}

export interface HlWithdraw3Action { type: 'withdraw3'; hyperliquidChain: 'Mainnet' | 'Testnet'; signatureChainId: string; destination: Hex; amount: string; time: number }
/**
 * DATA BUILDER ONLY — NOT WIRED TO ANYTHING. Typed data of a withdrawal through the Arbitrum bridge (`withdraw3`).
 * Sends funds OUT of the venue; must only ever be signed by the account key after an explicit owner decision.
 */
export function buildWithdraw3TypedDataOnly(o: { network: HlNetwork; destination: string; amount: string; time: number; signatureChainId?: string }): HlUserSigned<HlWithdraw3Action> {
  const signatureChainId = o.signatureChainId ?? HL_DEFAULT_SIGNATURE_CHAIN_ID, hyperliquidChain = hlChainName(o.network), amount = usdAmount(o.amount), destination = hlAddress(o.destination);
  u64(o.time, 'time');
  const typedData = userSignedTypedData(HL_PRIMARY.withdraw, HL_WITHDRAW_TYPES, { hyperliquidChain, destination, amount, time: o.time }, signatureChainId);
  return { action: { type: 'withdraw3', hyperliquidChain, signatureChainId, destination, amount, time: o.time }, typedData };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Digest and signature helpers (no key is ever handled here)

/** The 32-byte EIP-712 digest that the key signs. */
export function typedDataDigest(td: HlTypedData): Hex {
  const { EIP712Domain: _domain, ...types } = td.types;
  return hashTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message } as Parameters<typeof hashTypedData>[0]);
}

/** A 65-byte signature (r ‖ s ‖ v, as viem returns it) → the venue's { r, s, v } with v = 27 | 28. */
export function signatureFromHex(sig: string): HlSignature {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('signature must be 65 bytes of hex');
  const l = sig.toLowerCase();
  let v = parseInt(l.slice(130), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw new Error('signature v must be 27 or 28');
  return { r: `0x${l.slice(2, 66)}`, s: `0x${l.slice(66, 130)}`, v };
}

/** Accepts { r, s, v } (hex of up to 32 bytes — the SDK prints r and s without leading zeros) or a 65-byte hex string. */
export function normalizeSignature(sig: unknown): HlSignature {
  if (typeof sig === 'string') return signatureFromHex(sig);
  const o = sig as { r?: unknown; s?: unknown; v?: unknown } | null;
  if (!o || typeof o.r !== 'string' || typeof o.s !== 'string' || (o.v !== 27 && o.v !== 28)) throw new Error('signature must be { r, s, v } with v = 27 | 28');
  const word = (x: string): Hex => {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(x)) throw new Error('signature r/s must be hex of at most 32 bytes');
    return `0x${x.slice(2).toLowerCase().padStart(64, '0')}`;
  };
  return { r: word(o.r), s: word(o.s), v: o.v };
}

/** Which address made this signature over this typed data (what the venue itself does to find the signer). */
export async function recoverTypedDataSigner(td: HlTypedData, sig: unknown): Promise<Hex> {
  const s = normalizeSignature(sig);
  const a = await recoverAddress({ hash: typedDataDigest(td), signature: { r: s.r, s: s.s, v: BigInt(s.v) } });
  return a.toLowerCase() as Hex;
}
