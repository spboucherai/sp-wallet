// On-chain sale interpretation WITHOUT a provider (keyless, limited) — EVM, Seaport only.
//
// A transfer of an NFT is linked to a payment ONLY when the receipt of the SAME transaction contains a Seaport `OrderFulfilled`
// event, emitted by a recognised Seaport contract, that names this token on one side and a payment in ONE currency on the
// other, and the token's own Transfer log of that transaction has the same two parties. Anything else — another marketplace,
// several orders naming the token that do not resolve to one sale, a payment in several currencies, a criteria item — gives
// NOTHING: the event stays a transfer with no price. A bare transfer is never a sale.
//
// The result is an INTERPRETATION by SP Wallet of public transaction data: it is labelled as such everywhere it is shown
// (`interpretation.by = spw:seaport-order-fulfilled`), it is not a statement of a marketplace, and it says nothing about
// whether the two parties are related (no wash-trade judgement).
//
// Sources (read 2026-11-17, docs/nft/NFT-SOURCES.md §10.4):
//  - addresses: github.com/ProjectOpenSea/seaport docs/Deployments.md ("Canonical addresses"; 1.6 "checked onchain on
//    November 9 and 10, 2026" on, among others, the 8 EVM networks of this wallet's registry);
//  - event and structs: github.com/ProjectOpenSea/seaport-types src/interfaces/ConsiderationEventsAndErrors.sol,
//    src/lib/ConsiderationStructs.sol, src/lib/ConsiderationEnums.sol;
//  - checked against 5 real mainnet receipts recorded that day (services/api/test/fixtures/nft/market-seaport-receipts.json).
import { decodeAbiParameters, getAddress, keccak256, toHex, type Hex } from 'viem';

export const SEAPORT_LIST_VERSION = '2026-11-17';
/**
 * The recognised contracts — explicit, versioned, sourced. 1.6 is listed by the official deployments document for all 8 EVM
 * networks of the registry. 1.5, 1.4 and 1.1 are canonical addresses of the same document, which gives no per-chain list for
 * them: they are recognised where code was observed at the address on 2026-11-17 (7 networks; none on HyperEVM).
 */
const OLD = ['ethereum', 'base', 'arbitrum', 'polygon', 'optimism', 'bsc', 'avalanche'];
export const SEAPORT_CONTRACTS: { version: string; address: string; networks: string[] }[] = [
  { version: '1.6', address: '0x0000000000000068F116a894984e2DB1123eB395', networks: [...OLD, 'hyperevm'] },
  { version: '1.5', address: '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC', networks: OLD },
  { version: '1.4', address: '0x00000000000001ad428e4906aE43D8F9852d0dD6', networks: OLD },
  { version: '1.1', address: '0x00000000006c3852cbEf3e08E8dF289169EdE581', networks: OLD },
];
export const TOPIC_ORDER_FULFILLED = keccak256(toHex('OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])'));
const TOPIC_TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
const TOPIC_SINGLE = keccak256(toHex('TransferSingle(address,address,address,uint256,uint256)'));
const ORDER_DATA = [{ type: 'bytes32' }, { type: 'address' },
  { type: 'tuple[]', components: [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] },
  { type: 'tuple[]', components: [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }] }] as const;

export interface ReceiptLog { address: string; topics: string[]; data: string; logIndex: string }
interface Item { itemType: number; token: string; identifier: bigint; amount: bigint; recipient: string | null }
export interface SeaportOrder { seaport: { version: string; address: string }; logIndex: string; orderHash: string; offerer: string; zone: string; recipient: string; offer: Item[]; consideration: Item[] }
export interface SeaportSale {
  seaport: { version: string; address: string }; orderHash: string; logIndex: string;
  buyer: string; seller: string; quantity: string;
  /** what the buyer paid in total, base units */ amount: string;
  /** 'native' or the ERC-20 contract (checksummed) */ token: string;
  /** payment items that did not go to the seller: recipient and exact amount; the transaction does not say what each one is (marketplace fee, creator fee) */
  fees: { recipient: string; amount: string }[];
  /** `listing`: the seller's order was filled (the NFT was the offer); `offer`: a buyer's offer was accepted (the NFT was the consideration) */
  side: 'listing' | 'offer';
}

const lc = (s: string) => s.toLowerCase();
const addrOfTopic = (t: string | undefined): string | null => (t && /^0x[0-9a-fA-F]{64}$/.test(t) ? getAddress(`0x${t.slice(26)}`) : null);

/** Every `OrderFulfilled` of a receipt emitted by a recognised Seaport contract of this network. A log that does not decode is skipped. */
export function seaportOrders(network: string, logs: ReceiptLog[]): SeaportOrder[] {
  const known = new Map(SEAPORT_CONTRACTS.filter((c) => c.networks.includes(network)).map((c) => [lc(c.address), c]));
  const out: SeaportOrder[] = [];
  for (const l of logs) {
    const c = known.get(lc(l.address));
    if (!c || l.topics[0] !== TOPIC_ORDER_FULFILLED || l.topics.length !== 3) continue;
    try {
      const [orderHash, recipient, offer, consideration] = decodeAbiParameters(ORDER_DATA, l.data as Hex);
      out.push({ seaport: { version: c.version, address: c.address }, logIndex: BigInt(l.logIndex).toString(10), orderHash, offerer: addrOfTopic(l.topics[1])!, zone: addrOfTopic(l.topics[2])!, recipient: getAddress(recipient),
        offer: offer.map((i) => ({ itemType: i[0], token: getAddress(i[1]), identifier: i[2], amount: i[3], recipient: null })),
        consideration: consideration.map((i) => ({ itemType: i[0], token: getAddress(i[1]), identifier: i[2], amount: i[3], recipient: getAddress(i[4]) })) });
    } catch { /* not the event it claims to be: ignored */ }
  }
  return out;
}

/**
 * The sale of ONE token in ONE transaction, or null. `standard` decides which transfer log must confirm the parties.
 * Rules (each failure → null):
 *  1. exactly one order resolves the sale: the orders that name the token in their CONSIDERATION (an accepted offer — the
 *     buyer's order, whose offer is what the buyer pays) take precedence; else the orders that name it in their OFFER (a
 *     filled listing — its consideration is what the buyer pays). A matched pair (`matchOrders`) emits both for one sale:
 *     the buyer's order alone is read, so the sale is counted once;
 *  2. the payment side holds only native / ERC-20 items, all of ONE token, with a positive total;
 *  3. the token's own Transfer / TransferSingle log of this transaction goes from the seller to the buyer the order implies.
 */
export function interpretSeaportSale(network: string, logs: ReceiptLog[], asset: { contract: string; tokenId: string; standard: 'erc721' | 'erc1155' }): SeaportSale | null {
  const id = BigInt(asset.tokenId), nftType = asset.standard === 'erc721' ? 2 : 3;
  const isNft = (i: Item) => i.itemType === nftType && lc(i.token) === lc(asset.contract) && i.identifier === id;
  const orders = seaportOrders(network, logs);
  const asOffer = orders.filter((o) => o.consideration.some(isNft)), asListing = orders.filter((o) => o.offer.some(isNft));
  const side: SeaportSale['side'] | null = asOffer.length === 1 ? 'offer' : asOffer.length === 0 && asListing.length === 1 ? 'listing' : null;
  if (!side) return null;
  const o = side === 'offer' ? asOffer[0]! : asListing[0]!;
  const nftItems = (side === 'offer' ? o.consideration : o.offer).filter(isNft);
  if (nftItems.length !== 1) return null;
  const pay = side === 'offer' ? o.offer : o.consideration.filter((i) => !isNft(i));
  // the payment side: only native / ERC-20, one token; the NFT side of a listing must hold nothing else than the token
  if (pay.length === 0 || pay.some((i) => i.itemType !== 0 && i.itemType !== 1) || new Set(pay.map((i) => `${i.itemType}:${lc(i.token)}`)).size !== 1) return null;
  if (side === 'listing' && o.offer.length !== 1) return null;
  if (side === 'offer' && o.consideration.some((i) => !isNft(i) && (i.itemType > 1 || `${i.itemType}:${lc(i.token)}` !== `${pay[0]!.itemType}:${lc(pay[0]!.token)}`))) return null;
  const total = pay.reduce((t, i) => t + i.amount, 0n);
  if (total <= 0n) return null;
  // the token's own transfer in this transaction
  const moves: { from: string; to: string; qty: bigint }[] = [];
  for (const l of logs) {
    if (lc(l.address) !== lc(asset.contract)) continue;
    try {
      if (asset.standard === 'erc721' && l.topics[0] === TOPIC_TRANSFER && l.topics.length === 4 && BigInt(l.topics[3]!) === id) moves.push({ from: addrOfTopic(l.topics[1])!, to: addrOfTopic(l.topics[2])!, qty: 1n });
      if (asset.standard === 'erc1155' && l.topics[0] === TOPIC_SINGLE && l.topics.length === 4) { const [tid, v] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], l.data as Hex); if (tid === id) moves.push({ from: addrOfTopic(l.topics[2])!, to: addrOfTopic(l.topics[3])!, qty: v }); }
    } catch { /* skipped */ }
  }
  if (moves.length !== 1) return null; // none: not a transfer of this token; several: more happened than one sale — not interpreted
  const mv = moves[0]!, qty = nftItems[0]!.amount;
  if (mv.qty !== qty) return null;
  const buyer = side === 'offer' ? o.offerer : mv.to, seller = mv.from;
  if (lc(mv.to) !== lc(buyer)) return null;
  if (side === 'listing' && lc(o.offerer) !== lc(seller)) return null;
  if (side === 'offer' && lc(nftItems[0]!.recipient ?? '') !== lc(buyer)) return null;
  const fees = (side === 'offer' ? o.consideration.filter((i) => !isNft(i)) : pay.filter((i) => lc(i.recipient ?? '') !== lc(seller))).map((i) => ({ recipient: i.recipient!, amount: i.amount.toString(10) }));
  return { seaport: o.seaport, orderHash: o.orderHash, logIndex: o.logIndex, buyer, seller, quantity: qty.toString(10), amount: total.toString(10), token: pay[0]!.itemType === 0 ? 'native' : pay[0]!.token, fees, side };
}

/**
 * Solana: marketplace PROGRAMS, recognised only to say "marketplace program involved: <name>" on a transaction — never a
 * price (no instruction or event layout of these programs is decoded here). Each id is listed with where it was read.
 */
export const SOLANA_MARKET_PROGRAMS_VERSION = '2026-11-17';
export const SOLANA_MARKET_PROGRAMS: { id: string; name: string; source: string }[] = [
  // each id was read in the named official file on 2026-11-17 and checked on-chain (executable, owned by the upgradeable loader)
  { id: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', name: 'Magic Eden v2 (M2)', source: 'github.com/me-foundation/m2 README.md' },
  { id: 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc', name: 'Magic Eden MMM (pools)', source: 'github.com/me-foundation/mmm README.md, Mainnet row' },
  { id: 'M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1', name: 'Magic Eden M3 (compressed NFTs)', source: 'github.com/me-foundation/m3 README.md, Mainnet row' },
  { id: 'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN', name: 'Tensor Swap', source: 'github.com/tensor-hq/tensorswap-sdk src/tensorswap/constants.ts (TENSORSWAP_ADDR)' },
  { id: 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp', name: 'Tensor Marketplace', source: 'github.com/tensor-foundation/marketplace program/src/lib.rs declare_id! and README.md' },
  { id: 'hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk', name: 'Metaplex Auction House', source: 'github.com/metaplex-foundation/metaplex-program-library auction-house/program/src/lib.rs declare_id!' },
];
export const solanaMarketProgram = (programId: string): { id: string; name: string; source: string } | null => SOLANA_MARKET_PROGRAMS.find((p) => p.id === programId) ?? null;
