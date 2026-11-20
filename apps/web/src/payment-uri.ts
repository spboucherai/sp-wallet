/**
 * NEXT — Receive: a payment link for the networks that have a STANDARD one. The link carries the address and the network —
 * never an amount (the payer types it) — and is offered next to the plain address, which stays what the QR code holds.
 * A network without a published, widely read URI scheme gets no link (null): the address alone is shared. Pure: tested.
 */
export interface PaymentUri { uri: string; /** the name of the standard, shown to the owner */ standard: string }
const BIP21: Record<string, string> = { bitcoin: 'bitcoin', litecoin: 'litecoin', dogecoin: 'dogecoin' };
export function paymentUri(n: { id: string; family: string; chainRef?: string | null }, address: string): PaymentUri | null {
  if (!address) return null;
  // BIP-21 and its direct descendants: `<scheme>:<address>`
  if (BIP21[n.id]) return { uri: `${BIP21[n.id]}:${address}`, standard: 'BIP-21' };
  // CashAddr already carries its scheme (« bitcoincash:q… »); a legacy address gets it
  if (n.id === 'bitcoincash' || n.id === 'bch') return { uri: address.includes(':') ? address : `bitcoincash:${address}`, standard: 'BIP-21 (CashAddr)' };
  // EIP-681: the chain id says WHICH Ethereum-compatible network — the same address exists on all of them
  if (n.family === 'evm') return /^\d+$/.test(n.chainRef ?? '') ? { uri: `ethereum:${address}@${n.chainRef}`, standard: 'EIP-681' } : null;
  if (n.family === 'sol') return { uri: `solana:${address}`, standard: 'Solana Pay' };
  if (n.family === 'ton') return { uri: `ton://transfer/${address}`, standard: 'TON' };
  if (n.family === 'stellar') return { uri: `web+stellar:pay?destination=${encodeURIComponent(address)}`, standard: 'SEP-7' };
  if (n.family === 'cardano') return { uri: `web+cardano:${address}`, standard: 'CIP-13' };
  return null;
}
