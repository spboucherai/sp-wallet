// Recorded Jupiter /build answers (v1 transactions) with the message, intent and mainnet simulation that went with them
// (scripts/sim-jupiter.mts --record), and the means to re-address one to another wallet for a test.
import { readFileSync } from 'node:fs';
import { associatedTokenAddress, compileSolV1Message, decodeSolV1Message, NETWORKS, solMessageHash, TOKEN_PROGRAM, tokenProgramOf, WSOL_MINT, type Intent, type SolIxInput, type SolV1Message } from '@spw/core';

export interface JupFixture { wallet: string; from: string; to: string; converted: boolean; intent: Intent; message: string; build: any;
  simulation: { fee: number; unitsConsumed: number; preBalances: number[]; postBalances: number[]; preTokenBalances: any[]; postTokenBalances: any[] }; effects: { spent: string; received: string; rentKept: string } }
export const jupFixture = (name: string): JupFixture => JSON.parse(readFileSync(new URL(`../../packages/core/test/fixtures/jupiter-exec/${name}.json`, import.meta.url), 'utf8'));
const N = NETWORKS.solana!;
export const solToken = (sym: string) => (sym === 'SOL' ? N.native : N.tokens.find((t) => t.symbol === sym)!);
export const solMint = (sym: string) => (sym === 'SOL' ? WSOL_MINT : solToken(sym).id);
export const solTokenProgram = (sym: string) => (sym === 'SOL' ? TOKEN_PROGRAM : tokenProgramOf(solToken(sym)));
export const solAta = (owner: string, sym: string) => associatedTokenAddress(owner, solMint(sym), solTokenProgram(sym));
export const ixInputs = (m: SolV1Message): SolIxInput[] => m.instructions.map((x) => ({ program: x.program, data: Uint8Array.from(x.data), accounts: x.accounts.map((k) => ({ pubkey: k, signer: k === m.payer, writable: m.keys.indexOf(k) < m.keys.length - m.numReadonlyUnsigned })) }));

/** every address of the recorded wallet (itself and its token accounts of all registry assets) → the same for `me` */
export function addressMap(from: string, me: string): Record<string, string> {
  const map: Record<string, string> = { [from]: me };
  for (const t of [N.native, ...N.tokens]) map[solAta(from, t.symbol)] = solAta(me, t.symbol);
  return map;
}
/** the recorded /build answer as Jupiter would have given it to `me` */
export function buildFor(f: JupFixture, me: string): any {
  let s = JSON.stringify(f.build);
  for (const [a, b] of Object.entries(addressMap(f.wallet, me))) s = s.split(a).join(b);
  return JSON.parse(s);
}
/** the recorded message and intent, re-addressed to `me` (same instructions, same order, same account positions) */
export function readdress(f: JupFixture, me: string, keyId: string, o: Partial<Intent> = {}): { intent: Intent; message: string; msg: Uint8Array } {
  const m = decodeSolV1Message(new Uint8Array(Buffer.from(f.message, 'base64'))), map = addressMap(f.wallet, me);
  const msg = compileSolV1Message({ payer: me, blockhash: m.blockhash, computeUnitLimit: m.computeUnitLimit, priorityFeeLamports: m.priorityFeeLamports, loadedAccountsDataSizeLimit: m.loadedAccountsDataSizeLimit,
    instructions: ixInputs(m).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a, pubkey: map[a.pubkey] ?? a.pubkey })) })) });
  const intent: Intent = { ...f.intent, keyId, from: me, to: me, ...o, swap: { ...f.intent.swap!, dataHash: solMessageHash(msg) } };
  return { intent, message: Buffer.from(msg).toString('base64'), msg };
}
