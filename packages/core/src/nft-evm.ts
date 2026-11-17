// NFT delivery 2 — EVM. The ONLY two calls an NFT intent can become:
//
//   ERC-721   safeTransferFrom(address from, address to, uint256 tokenId)                              selector 0x42842e0e, 100 bytes
//   ERC-1155  safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data = "")   selector 0xf242432a, 196 bytes
//
// `buildNftEvmTx` builds the transaction from the intent's semantic fields; `from` in the calldata is the intent's `from`, which
// the signer has already required to be ITS OWN address. `verifyNftEvmTx` is an independent reader of a built transaction: it
// decodes the bytes word by word (no ABI library) and refuses anything that is not exactly that call. The signer runs it on its
// own output before signing (a defect of the builder cannot become a signature), and the tests feed it every forged shape.
//
// Not expressible, on purpose: transferFrom (no receiver check), approve, setApprovalForAll, safeBatchTransferFrom, a non-empty
// `data`, a value in the native coin, an access list, any other selector.
import { encodeAbiParameters, getAddress, type TransactionSerializableEIP1559 } from 'viem';
import { baseUnits } from './amounts.ts';
import { normalizeAddress } from './address.ts';
import { getNetwork } from './networks.ts';
import { NftRefusal, type NftIntent } from './nft-intent.ts';

export const SEL_ERC721_SAFE_TRANSFER = '0x42842e0e';
export const SEL_ERC1155_SAFE_TRANSFER = '0xf242432a';
/** Upper bound of the gas limit of an NFT transfer: a safe transfer runs the collection's code and, for a contract recipient, its receiver hook. */
export const NFT_EVM_GAS_CAP = 500_000n;
const UINT256 = 1n << 256n;
const refuse = (code: string, msg: string): never => { throw new NftRefusal(code, msg); };

interface Checked { chainId: number; contract: `0x${string}`; from: `0x${string}`; to: `0x${string}`; tokenId: bigint; quantity: bigint; gas: bigint; maxFeePerGas: bigint; tip: bigint; nonce: number }
/** Every check of an EVM NFT intent that needs no chain state. Throws an NftRefusal with a stable code. */
export function checkNftEvmIntent(i: NftIntent): Checked {
  let n; try { n = getNetwork(i.network); } catch { return refuse('nft_wrong_chain', 'unknown network'); }
  if (n.family !== 'evm' || !i.evm || i.sol) refuse('nft_section_mismatch', 'not an EVM NFT intent');
  if (i.chainRef !== n.chainRef) refuse('nft_wrong_chain', 'chain id does not match the network');
  if (i.standard !== 'erc721' && i.standard !== 'erc1155') refuse('nft_standard_network_mismatch', `${i.standard} is not an EVM standard`);
  const addr = (v: string, what: string): `0x${string}` => {
    let a: string; try { a = normalizeAddress(i.network, v); } catch (e) { return refuse(`nft_bad_${what}`, `invalid ${what}: ${(e as Error).message}`); }
    if (a !== v) refuse(`nft_bad_${what}`, `${what} is not in its normalized (EIP-55) form`);
    return a as `0x${string}`;
  };
  const contract = addr(i.asset, 'contract'), from = addr(i.from, 'source'), to = addr(i.to, 'destination');
  if (i.program !== i.asset) refuse('nft_program_mismatch', 'the contract called must be the token contract itself');
  // a contract of the wallet's fungible registry is never an NFT (verify the standard, never the selector alone)
  if ([...n.tokens].some((t) => t.id.toLowerCase() === contract.toLowerCase())) refuse('nft_contract_is_fungible_token', 'this contract is a registered fungible token, not an NFT collection');
  if (to === contract) refuse('nft_destination_is_contract_itself', 'the destination is the token contract itself');
  if (to === from) refuse('nft_self_send', 'the destination is the wallet itself');
  if (i.tokenId === undefined) refuse('nft_bad_token_id', 'an EVM NFT intent names its token id');
  const tokenId = BigInt(i.tokenId!), quantity = baseUnits(i.quantity);
  if (tokenId >= UINT256) refuse('nft_bad_token_id', 'token id out of the uint256 range');
  if (quantity < 1n) refuse('nft_bad_quantity', 'quantity must be at least 1');
  if (i.standard === 'erc721' && quantity !== 1n) refuse('nft_bad_quantity', 'an ERC-721 transfer moves exactly one token');
  if (quantity >= UINT256) refuse('nft_bad_quantity', 'quantity out of the uint256 range');
  const gas = baseUnits(i.evm!.gasLimit), maxFeePerGas = baseUnits(i.evm!.maxFeePerGas), tip = baseUnits(i.evm!.maxPriorityFeePerGas);
  if (gas < 21_000n || gas > NFT_EVM_GAS_CAP) refuse('nft_gas_cap', `gas limit outside 21 000 – ${NFT_EVM_GAS_CAP}`);
  if (tip > maxFeePerGas) refuse('nft_fee_exceeds_max', 'priority fee above max fee');
  if (gas * maxFeePerGas > baseUnits(i.maxFee)) refuse('nft_fee_exceeds_max', 'fee exceeds the approved maximum');
  if (!Number.isSafeInteger(i.evm!.nonce)) refuse('nft_bad_nonce', 'nonce out of range');
  return { chainId: Number(n.chainRef), contract, from, to, tokenId, quantity, gas, maxFeePerGas, tip, nonce: i.evm!.nonce };
}

/** Build the exact unsigned EIP-1559 transaction of an EVM NFT intent. */
export function buildNftEvmTx(i: NftIntent): TransactionSerializableEIP1559 {
  const c = checkNftEvmIntent(i);
  const args = i.standard === 'erc721'
    ? encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [c.from, c.to, c.tokenId])
    : encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], [c.from, c.to, c.tokenId, c.quantity, '0x']);
  const data = `${i.standard === 'erc721' ? SEL_ERC721_SAFE_TRANSFER : SEL_ERC1155_SAFE_TRANSFER}${args.slice(2)}` as `0x${string}`;
  return { type: 'eip1559', chainId: c.chainId, nonce: c.nonce, gas: c.gas, maxFeePerGas: c.maxFeePerGas, maxPriorityFeePerGas: c.tip, to: c.contract, value: 0n, data };
}

const KNOWN_KEYS = new Set(['type', 'chainId', 'nonce', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'to', 'value', 'data']);
/**
 * Independent reading of a transaction that claims to be the transfer of `i`. It does not call the builder: the calldata is cut
 * into 32-byte words and each is compared with the intent. Throws an NftRefusal naming the first difference.
 */
export function verifyNftEvmTx(tx: Record<string, unknown>, i: NftIntent): void {
  const c = checkNftEvmIntent(i);
  for (const k of Object.keys(tx)) if (!KNOWN_KEYS.has(k) && tx[k] !== undefined) refuse('nft_tx_unknown_field', `unexpected transaction field "${k}"`);
  if (tx.type !== 'eip1559') refuse('nft_tx_type', 'not an EIP-1559 transaction');
  if (tx.chainId !== c.chainId) refuse('nft_wrong_chain', 'transaction chain id differs from the intent');
  if (tx.nonce !== c.nonce) refuse('nft_bad_nonce', 'transaction nonce differs from the intent');
  if (tx.gas !== c.gas || tx.maxFeePerGas !== c.maxFeePerGas || tx.maxPriorityFeePerGas !== c.tip) refuse('nft_fee_exceeds_max', 'transaction gas parameters differ from the intent');
  if (tx.value !== 0n) refuse('nft_tx_value', 'an NFT transfer sends no native coin');
  if (typeof tx.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tx.to) || getAddress(tx.to) !== c.contract) refuse('nft_contract_substituted', 'the transaction does not call the contract of the intent');
  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : '';
  if (!/^0x([0-9a-f]{2})+$/.test(data)) refuse('nft_calldata', 'malformed calldata');
  const sel = data.slice(0, 10), body = data.slice(10);
  const want = i.standard === 'erc721' ? SEL_ERC721_SAFE_TRANSFER : SEL_ERC1155_SAFE_TRANSFER;
  if (sel !== want) refuse('nft_selector', `selector ${sel} is not ${i.standard === 'erc721' ? 'ERC-721' : 'ERC-1155'} safeTransferFrom`);
  const words = i.standard === 'erc721' ? 3 : 6;
  if (body.length !== words * 64) refuse('nft_calldata_length', `calldata must be exactly ${4 + words * 32} bytes`);
  const w = (k: number) => BigInt('0x' + body.slice(k * 64, (k + 1) * 64));
  const asAddr = (k: number) => { if (w(k) >> 160n !== 0n) refuse('nft_calldata', 'dirty address word'); return getAddress('0x' + body.slice(k * 64 + 24, (k + 1) * 64)); };
  if (asAddr(0) !== c.from) refuse('nft_wrong_source', 'the calldata does not move the token from the wallet');
  if (asAddr(1) !== c.to) refuse('nft_destination_substituted', 'the calldata destination differs from the intent');
  if (w(2) !== c.tokenId) refuse('nft_token_id_substituted', 'the calldata token id differs from the intent');
  if (i.standard === 'erc1155') {
    if (w(3) !== c.quantity) refuse('nft_quantity_substituted', 'the calldata quantity differs from the intent');
    if (w(4) !== 0xa0n) refuse('nft_calldata', 'unexpected offset of the data argument');
    if (w(5) !== 0n) refuse('nft_data_not_empty', 'the ERC-1155 data argument must be empty');
  }
}
