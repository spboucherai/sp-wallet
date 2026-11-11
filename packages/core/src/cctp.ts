// Cross-chain USDC through Circle CCTP V2 (burn on one EVM network, mint on another), wallet to itself only.
//
// There is NO third-party calldata here. Both transactions are built from the approved intent and pinned constants:
//   leg 1 (source):       USDC.approve(TokenMessengerV2, amount)  +  TokenMessengerV2.depositForBurn(amount, destinationDomain,
//                         mintRecipient = the wallet itself, burnToken = registry USDC, destinationCaller = 0, maxFee, minFinalityThreshold)
//   leg 2 (destination):  MessageTransmitterV2.receiveMessage(message, attestation)
// The only outside data is the attested message of leg 2 (from Circle's attestation service). It is parsed here byte by byte
// and must describe exactly the burn that was approved; whatever passes these checks can only mint the wallet's own USDC to
// the wallet's own address, or revert (the contract checks Circle's signatures and that the nonce is unused).
//
// Read from the verified sources (TokenMessengerV2, MessageTransmitterV2, MessageV2, BurnMessageV2; explorers + Circle's
// repository, 2026-11-10/11):
//   - depositForBurn requires amount > 0, mintRecipient != 0, maxFee < amount, a registered remote messenger; it pulls exactly
//     `amount` of burnToken from msg.sender, burns it, and emits a message whose body carries burnToken, mintRecipient, amount,
//     messageSender = msg.sender and maxFee, with an empty hook;
//   - receiveMessage checks the attestation, destinationDomain == local, destinationCaller (0 = anyone), version, unused nonce,
//     then the messenger mints `amount - feeExecuted` to mintRecipient (feeExecuted <= maxFee enforced on-chain) and the fee to
//     Circle's fee recipient. The caller of receiveMessage receives nothing and gives nothing but gas.
import { encodeFunctionData, erc20Abi, keccak256, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { baseUnits } from './amounts.ts';
import { getAsset, getNetwork } from './networks.ts';
import type { Intent } from './intent.ts';

/** CCTP V2 on EVM: the same addresses on every chain (developers.circle.com/cctp/references/contract-addresses, read 2026-11-11). */
export const CCTP_TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const CCTP_MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
export const CCTP_TOKEN_MINTER = '0xfd78EE919681417d192449715b2594ab58f5D002';
/** Both entry points are Circle's AdminUpgradableProxy (EIP-1967 slots); its 2 175-byte runtime code is identical on every network. */
export const CCTP_PROXY_SHA256 = '501b4a60e24ea82032b7442d75995dee3bdbfc17b25caffc3c955eadc8c2a418';
/** TokenMinterV2 is not a proxy; its runtime code is identical on every network. */
export const CCTP_MINTER_SHA256 = 'ddc1bfebb8465377e23aea86ef3135551130ae35426b759e69c1644735074be6';
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const CCTP_FINALITY_FAST = 1000, CCTP_FINALITY_STANDARD = 2000;
/** The fee the owner may accept for a Fast transfer is bounded here whatever the API says (Circle charges 1–1.4 bps today). */
export const CCTP_MAX_FEE_BPS = 100n;

export interface CctpPin {
  /** Circle's domain id (not a chain id) */
  domain: number;
  /** implementation behind each proxy: address and SHA-256 of its runtime bytecode. A change = an upgrade by Circle = refuse until re-reviewed. */
  messengerImpl: { address: string; codeSha256: string };
  transmitterImpl: { address: string; codeSha256: string };
  /** Circle offers Fast Transfer from this source (documented finality table) */
  fastSource: boolean;
  /** documented time for the attestation to become available, seconds (upper bound of the documented range) */
  standardSeconds: number; fastSeconds: number | null;
  reviewed: string;
}
const M6 = { address: '0x555e272506c06e7e559D57418563742aFe363Ec8', codeSha256: '81ca2a58e76495642226a9ba09391e5c4c6f8edf618f205dff274d1313144ffa' };
const SRC = 'proxy + implementation bytecode read on both registry RPC endpoints 2026-11-11 (scripts/cctp-pins.mts); verified source on the explorer compared with circlefin/evm-cctp-contracts';
/**
 * Networks where CCTP execution is enabled. Addresses are Circle's documented ones; the hashes were computed from the code
 * returned by both RPC endpoints of the registry. The API refuses to prepare or finish a transfer when any of them differs.
 */
export const CCTP_ENABLED: Record<string, CctpPin> = {
  ethereum: { domain: 0, messengerImpl: M6, transmitterImpl: { address: '0xa30c41865729C248067704d4DB9F38385cbe1186', codeSha256: 'b7b2a422acb8daa761be34977acc451fc3754cec19ec8e11d1cb572e3861307d' }, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 20, reviewed: SRC },
  avalanche: { domain: 1, messengerImpl: M6, transmitterImpl: { address: '0x8689f0a21FE82b30E8f7684902788f65D891daE6', codeSha256: '6c541f8c79e433689fd64656e8a4c710f7f4ab44e6b0472cc934d8c52cadb303' }, fastSource: false, standardSeconds: 8, fastSeconds: null, reviewed: SRC },
  optimism: { domain: 2, messengerImpl: M6, transmitterImpl: { address: '0x1F33335414afB7305367452D00a0D024B0184EA8', codeSha256: '1c4986994c9f845d3c91adb6382b5c04ebe73819f599b45e83ee94cff64efba0' }, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 8, reviewed: SRC },
  arbitrum: { domain: 3, messengerImpl: M6, transmitterImpl: { address: '0x7B93dB2bC72FAF642ceC0AdCAC4f91718831A1f4', codeSha256: 'bad293319d77ab3eed9877b254f57c176ef942e6f1afc7baf352e5685481a775' }, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 8, reviewed: SRC },
  base: { domain: 6, messengerImpl: M6, transmitterImpl: { address: '0x7DB629F6aCc20bE49A0A7565C21cC178E9ac21e3', codeSha256: '5814f08b2cfc739969f545b292e0bac835b38011d5efbd936f921bde393d8fca' }, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 8, reviewed: SRC },
  polygon: { domain: 7, messengerImpl: M6, transmitterImpl: { address: '0xd40518c1A3139e8F1F73F83E5De74E05C88F5aD3', codeSha256: '540cd1aece247c990c0a0d10491f717c966cd09cb78b7c6905f17d85b021fc4e' }, fastSource: false, standardSeconds: 8, fastSeconds: null, reviewed: SRC },
  // HyperEVM runs the newer messenger build with the Standard-fee switch (minFee, 0 today): the API reads getMinFeeAmount there
  hyperevm: { domain: 19, messengerImpl: { address: '0x1cCAFdFfBC1b7B5c499C97322F961b7D929a41B4', codeSha256: 'cff375318c7d5edac5e328ae8b49634f9127d68b88165cfd9c93f2ca6e8f2464' }, transmitterImpl: { address: '0x17eAEc8Bb0D05e8dA2E96aD69121fEe6dD62d313', codeSha256: 'e9423da6e41a7a11455980721a885b8150babbe1628871d8e5d7316fd3299ddf' }, fastSource: false, standardSeconds: 5, fastSeconds: null, reviewed: SRC },
};

export const CCTP_ABI = [
  { type: 'function', name: 'depositForBurn', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' }, { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' }] },
  { type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable', outputs: [{ name: 'success', type: 'bool' }], inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }] },
  { type: 'function', name: 'usedNonces', stateMutability: 'view', outputs: [{ type: 'uint256' }], inputs: [{ name: 'nonce', type: 'bytes32' }] },
  { type: 'function', name: 'getMinFeeAmount', stateMutability: 'view', outputs: [{ type: 'uint256' }], inputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'event', name: 'MessageSent', inputs: [{ name: 'message', type: 'bytes', indexed: false }] },
  { type: 'event', name: 'MessageReceived', inputs: [{ name: 'caller', type: 'address', indexed: true }, { name: 'sourceDomain', type: 'uint32', indexed: false }, { name: 'nonce', type: 'bytes32', indexed: true },
    { name: 'sender', type: 'bytes32', indexed: false }, { name: 'finalityThresholdExecuted', type: 'uint32', indexed: true }, { name: 'messageBody', type: 'bytes', indexed: false }] },
] as const;

const ZERO32 = '0'.repeat(64);
const HEADER = 148, BODY = 228, MESSAGE_BYTES = HEADER + BODY; // a burn message without hook data is exactly 376 bytes
const BURN_GAS_MIN = 80_000n, BURN_GAS_MAX = 400_000n, MINT_GAS_MIN = 100_000n, MINT_GAS_MAX = 450_000n, APPROVE_GAS_MAX = 120_000n;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** An EVM address as the bytes32 CCTP uses (left-padded), lowercase hex without 0x. */
export function cctpBytes32(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('not an EVM address');
  return '0'.repeat(24) + address.slice(2).toLowerCase();
}

/** The registry USDC of a network (the only burnable / mintable token here). */
export function cctpUsdc(network: string) {
  const n = getNetwork(network);
  const t = n.tokens.find((x) => x.symbol === 'USDC');
  if (!t || n.family !== 'evm') throw new Error(`no native USDC in the registry for ${n.name}`);
  return t;
}

/** What an approved bridge commits to; the signer keeps this record to authorise the one matching mint later. */
export interface CctpBridge { fromNetwork: string; toNetwork: string; wallet: string; amount: string; maxFee: string; minFinalityThreshold: number }

export function bridgeOf(i: Intent): CctpBridge {
  if (!i.bridge) throw new Error('not a bridge intent');
  return { fromNetwork: i.network, toNetwork: i.bridge.toNetwork, wallet: i.from, amount: i.amount, maxFee: i.bridge.maxFee, minFinalityThreshold: i.bridge.minFinalityThreshold };
}

/** Check every field of a bridge intent against the pinned tables. Throws on any mismatch. */
export function verifyCctpBridge(i: Intent): { src: CctpPin; dst: CctpPin; amount: bigint; maxFee: bigint } {
  const n = getNetwork(i.network), b = i.bridge;
  if (n.family !== 'evm' || !i.evm || !b) throw new Error('not an EVM bridge intent');
  if (i.swap || i.xswap) throw new Error('an intent is a swap or a bridge, not both');
  if (b.provider !== 'cctp') throw new Error('unknown bridge provider');
  const src = CCTP_ENABLED[i.network], dst = CCTP_ENABLED[b.toNetwork];
  if (!src) throw new Error(`CCTP execution is not enabled on ${n.name}`);
  if (!dst) throw new Error('CCTP execution is not enabled on the destination network');
  if (b.toNetwork === i.network) throw new Error('source and destination are the same network');
  if (i.chainRef !== n.chainRef) throw new Error('chain id mismatch');
  if (b.toDomain !== dst.domain) throw new Error('destination domain does not match the destination network');
  if (b.messenger !== CCTP_TOKEN_MESSENGER) throw new Error('messenger is not the pinned TokenMessengerV2');
  if (b.transmitter !== CCTP_MESSAGE_TRANSMITTER) throw new Error('transmitter is not the pinned MessageTransmitterV2');
  if (!/^0x[0-9a-fA-F]{40}$/.test(i.from) || i.to !== i.from) throw new Error('a bridge must deliver to the wallet itself');
  const usdc = cctpUsdc(i.network); cctpUsdc(b.toNetwork);
  if (i.asset !== usdc.id || getAsset(i.network, i.asset).id !== usdc.id) throw new Error('only the registry USDC can be bridged');
  if (i.symbol !== 'USDC' || i.decimals !== usdc.decimals) throw new Error('asset metadata mismatch');
  const amount = baseUnits(i.amount), maxFee = baseUnits(b.maxFee);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (maxFee >= amount) throw new Error('CCTP fee ceiling must be below the amount');
  if (maxFee * 10_000n > amount * CCTP_MAX_FEE_BPS) throw new Error('CCTP fee ceiling above 1 % of the amount');
  if (b.minFinalityThreshold !== CCTP_FINALITY_FAST && b.minFinalityThreshold !== CCTP_FINALITY_STANDARD) throw new Error('finality threshold must be 1000 (Fast) or 2000 (Standard)');
  if (b.minFinalityThreshold === CCTP_FINALITY_FAST && !src.fastSource) throw new Error('Fast Transfer is not offered from this network');
  return { src, dst, amount, maxFee };
}

/** Calldata of the burn, rebuilt from the intent alone. */
export function cctpBurnData(i: Intent): Hex {
  const { dst, amount, maxFee } = verifyCctpBridge(i);
  return encodeFunctionData({ abi: CCTP_ABI, functionName: 'depositForBurn', args: [amount, dst.domain, `0x${cctpBytes32(i.from)}`, cctpUsdc(i.network).id as Hex, `0x${ZERO32}`, maxFee, i.bridge!.minFinalityThreshold] });
}

/** The transactions the signer signs for the first leg: an exact-amount approval when asked, then the burn. */
export function buildCctpBurnTxs(i: Intent): { approve: TransactionSerializableEIP1559 | null; burn: TransactionSerializableEIP1559 } {
  const { amount } = verifyCctpBridge(i);
  const n = getNetwork(i.network), e = i.evm!, b = i.bridge!;
  const gas = baseUnits(e.gasLimit), maxFeePerGas = baseUnits(e.maxFeePerGas), tip = baseUnits(e.maxPriorityFeePerGas), approveGas = baseUnits(b.approveGas);
  if (tip > maxFeePerGas) throw new Error('priority fee above max fee');
  if (gas < BURN_GAS_MIN || gas > BURN_GAS_MAX) throw new Error('burn gas limit out of range');
  // approveGas 0 = no approval transaction: the existing allowance already covers the amount (if not, the burn simply reverts)
  if (approveGas !== 0n && (approveGas < 30_000n || approveGas > APPROVE_GAS_MAX)) throw new Error('approval gas out of range');
  if ((gas + approveGas) * maxFeePerGas > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const common = { type: 'eip1559' as const, chainId: Number(n.chainRef), maxFeePerGas, maxPriorityFeePerGas: tip };
  const approve = approveGas === 0n ? null : {
    ...common, nonce: e.nonce, gas: approveGas, to: cctpUsdc(i.network).id as Hex, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CCTP_TOKEN_MESSENGER as Hex, amount] }), // exact amount, never unlimited
  };
  const burn = { ...common, nonce: e.nonce + (approve ? 1 : 0), gas, to: CCTP_TOKEN_MESSENGER as Hex, value: 0n, data: cctpBurnData(i) };
  return { approve, burn };
}

export interface CctpMessage {
  version: number; sourceDomain: number; destinationDomain: number; nonce: string; sender: string; recipient: string; destinationCaller: string;
  minFinalityThreshold: number; finalityThresholdExecuted: number;
  body: { version: number; burnToken: string; mintRecipient: string; amount: bigint; messageSender: string; maxFee: bigint; feeExecuted: bigint; expirationBlock: bigint };
}

const hexOk = (s: unknown): s is string => typeof s === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(s);

/** Parse a CCTP V2 burn message (header 148 bytes + body 228 bytes, no hook data). bytes32 fields are lowercase hex without 0x. */
export function decodeCctpMessage(message: string): CctpMessage {
  if (!hexOk(message)) throw new Error('message is not hex');
  const h = message.slice(2).toLowerCase();
  if (h.length !== MESSAGE_BYTES * 2) throw new Error(`message is ${h.length / 2} bytes, a burn message without hook is ${MESSAGE_BYTES}`);
  const at = (o: number, len: number) => h.slice(o * 2, (o + len) * 2);
  const u32 = (o: number) => parseInt(at(o, 4), 16), u256 = (o: number) => BigInt('0x' + at(o, 32));
  const B = HEADER;
  return {
    version: u32(0), sourceDomain: u32(4), destinationDomain: u32(8), nonce: at(12, 32), sender: at(44, 32), recipient: at(76, 32), destinationCaller: at(108, 32),
    minFinalityThreshold: u32(140), finalityThresholdExecuted: u32(144),
    body: { version: u32(B), burnToken: at(B + 4, 32), mintRecipient: at(B + 36, 32), amount: u256(B + 68), messageSender: at(B + 100, 32), maxFee: u256(B + 132), feeExecuted: u256(B + 164), expirationBlock: u256(B + 196) },
  };
}

/** Inverse of decodeCctpMessage (tests and the fork proof build messages with it). */
export function encodeCctpMessage(m: CctpMessage): Hex {
  const u32 = (v: number) => v.toString(16).padStart(8, '0'), u256 = (v: bigint) => v.toString(16).padStart(64, '0');
  const b = m.body;
  const out = u32(m.version) + u32(m.sourceDomain) + u32(m.destinationDomain) + m.nonce + m.sender + m.recipient + m.destinationCaller + u32(m.minFinalityThreshold) + u32(m.finalityThresholdExecuted)
    + u32(b.version) + b.burnToken + b.mintRecipient + u256(b.amount) + b.messageSender + u256(b.maxFee) + u256(b.feeExecuted) + u256(b.expirationBlock);
  if (out.length !== MESSAGE_BYTES * 2 || !/^[0-9a-f]+$/.test(out)) throw new Error('malformed message fields');
  return `0x${out}`;
}

/** keccak256 of the message bytes: what Circle's attesters sign, and what binds a mint to one message. */
export const cctpMessageHash = (message: string): string => keccak256(message as Hex).slice(2);

/**
 * Leg 2: the attested message must be exactly the approved burn — same route, same token, same amount, same fee ceiling and
 * finality, burned by the wallet, minted to the wallet, no hook, callable by anyone. Returns the parsed message and what
 * the mint will credit. Throws on any mismatch.
 */
export function verifyCctpMint(b: CctpBridge, message: string, attestation: string): { msg: CctpMessage; minted: bigint; messageHash: string } {
  const src = CCTP_ENABLED[b.fromNetwork], dst = CCTP_ENABLED[b.toNetwork];
  if (!src || !dst || b.fromNetwork === b.toNetwork) throw new Error('bridge route is not enabled');
  const m = decodeCctpMessage(message);
  const messenger = cctpBytes32(CCTP_TOKEN_MESSENGER), wallet = cctpBytes32(b.wallet);
  if (m.version !== 1 || m.body.version !== 1) throw new Error('message is not CCTP V2');
  if (m.sourceDomain !== src.domain) throw new Error('message comes from another source domain');
  if (m.destinationDomain !== dst.domain) throw new Error('message is for another destination domain');
  if (m.nonce === ZERO32) throw new Error('message has no nonce (not attested)');
  if (m.sender !== messenger || m.recipient !== messenger) throw new Error('message is not between the pinned TokenMessengers');
  if (m.destinationCaller !== ZERO32) throw new Error('message restricts the destination caller');
  if (m.body.burnToken !== cctpBytes32(cctpUsdc(b.fromNetwork).id)) throw new Error('message burns another token');
  if (m.body.mintRecipient !== wallet) throw new Error('message mints to another address');
  if (m.body.messageSender !== wallet) throw new Error('message was not burned by this wallet');
  if (m.body.amount !== baseUnits(b.amount)) throw new Error('message carries another amount');
  if (m.body.maxFee !== baseUnits(b.maxFee)) throw new Error('message carries another fee ceiling');
  if (m.body.feeExecuted > m.body.maxFee) throw new Error('message charges more than the approved fee ceiling');
  if (m.minFinalityThreshold !== b.minFinalityThreshold) throw new Error('message asks for another finality threshold');
  if (m.finalityThresholdExecuted < b.minFinalityThreshold) throw new Error('message was attested below the approved finality');
  if (!hexOk(attestation)) throw new Error('attestation is not hex');
  const sigBytes = (attestation.length - 2) / 2;
  if (sigBytes < 65 || sigBytes > 65 * 8 || sigBytes % 65 !== 0) throw new Error('attestation is not a list of 65-byte signatures');
  return { msg: m, minted: m.body.amount - m.body.feeExecuted, messageHash: cctpMessageHash(message) };
}

export interface CctpMintGas { nonce: number; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }

/** The one transaction of the second leg. `feeCeiling` is the signer policy's native fee ceiling for the destination network. */
export function buildCctpMintTx(b: CctpBridge, message: string, attestation: string, g: CctpMintGas, feeCeiling: bigint): TransactionSerializableEIP1559 {
  verifyCctpMint(b, message, attestation);
  const n = getNetwork(b.toNetwork);
  if (!Number.isInteger(g.nonce) || g.nonce < 0) throw new Error('bad nonce');
  const gas = baseUnits(g.gasLimit), maxFeePerGas = baseUnits(g.maxFeePerGas), tip = baseUnits(g.maxPriorityFeePerGas);
  if (tip > maxFeePerGas) throw new Error('priority fee above max fee');
  if (gas < MINT_GAS_MIN || gas > MINT_GAS_MAX) throw new Error('mint gas limit out of range');
  if (gas * maxFeePerGas > feeCeiling) throw new Error('mint fee above the policy ceiling of the destination network');
  return { type: 'eip1559', chainId: Number(n.chainRef), nonce: g.nonce, gas, maxFeePerGas, maxPriorityFeePerGas: tip, to: CCTP_MESSAGE_TRANSMITTER as Hex, value: 0n,
    data: encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [message as Hex, attestation as Hex] }) };
}

const enc = new TextEncoder();
/**
 * Challenge for a passkey-approved RE-SIGNATURE of a mint (the first one is covered by the burn approval). Binds the bridge,
 * the message and the exact gas parameters. Returned as the string to hash with SHA-256 (the signer and the API hash it the same way).
 */
export function cctpMintRetryBytes(proposalId: string, messageHash: string, g: CctpMintGas): Uint8Array {
  return enc.encode(['SPW-BRIDGE-MINT-v1', proposalId, messageHash, String(g.nonce), g.gasLimit, g.maxFeePerGas, g.maxPriorityFeePerGas].join('\n'));
}
