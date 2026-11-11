// Withdrawal signature proof. The REAL isolated signer class signs Hyperliquid's `withdraw3` with a THROWAWAY wallet key
// (a BIP-39 phrase generated in memory, never printed, gone when the process ends) after a real WebAuthn assertion from a
// software passkey; the signature is checked by recovering the signer from the typed data, the way the venue does.
//     npx tsx scripts/hl-withdraw-testnet.mts [--send] [--record]
//
//   - always: a Testnet and a Mainnet signature are produced and verified LOCALLY (recovered address = the wallet's own address,
//     destination = that same address); the signer's refusals are shown (another destination, amount ≤ fee, no passkey, replay).
//   - `--send`: the TESTNET signature only is posted to https://api.hyperliquid-testnet.xyz/exchange. The account is a throwaway
//     address that never deposited, so the venue refuses it; its answer names the address it recovered from our signature,
//     which proves its hash of the action equals ours. Nothing of value can move: the account holds nothing, on a test network.
//   - NEVER mainnet: the Mainnet signature is never sent anywhere, and every request to api.hyperliquid.xyz is refused by this
//     script before it leaves the process.
//   - `--record` (with --send) writes the exchange to packages/derivatives/test/fixtures/hyperliquid/testnet-withdraw-proof.json.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { recoverTypedDataSigner, venueWithdrawalHash, type VenueWithdrawal } from '@spw/derivatives/live';
import { buildWithdraw3TypedDataOnly } from '../packages/derivatives/src/venues/hyperliquid/signing.ts';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const SEND = process.argv.includes('--send'), RECORD = process.argv.includes('--record');
const TESTNET = 'https://api.hyperliquid-testnet.xyz', RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  if (u.host === 'api.hyperliquid.xyz') throw new Error(`refusing a request to Hyperliquid MAINNET (${u.pathname})`);
  if (u.host !== 'api.hyperliquid-testnet.xyz') throw new Error(`refusing a request to ${u.host}: this script only talks to the Hyperliquid testnet`);
  return realFetch(url, init);
}) as typeof fetch;
const say = (s = '') => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };

const keys = deriveKeys(generateMnemonic(wordlist, 128)), ME = keys.addresses.evm.toLowerCase(); // fresh throwaway wallet
const dir = mkdtempSync(join(tmpdir(), 'spw-hl-withdraw-'));
const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
const pk = new TestPasskey(RP, ORIGIN);
await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
let bump = 0;
const withdrawal = (network: 'mainnet' | 'testnet', o: Partial<VenueWithdrawal> = {}): VenueWithdrawal => { const now = Math.floor(Date.now() / 1000);
  return { v: 1, withdrawalId: randomUUID(), keyId: keys.keyId, venue: 'hyperliquid', network, account: ME, destination: ME, amount: '12.3', fee: '1', time: Date.now() + ++bump, createdAt: now, expiresAt: now + 120, ...o }; };
const sign = (w: VenueWithdrawal) => signer.venueWithdraw(w, pk.assert(venueWithdrawalHash(w)));
async function refused(label: string, p: Promise<unknown>, re: RegExp) {
  try { await p; check(false, `${label}: was NOT refused`); } catch (e) { const m = `${(e as { code?: string }).code}: ${(e as Error).message}`; check(re.test(m), `${label} → refused (${m.slice(0, 110)})`); }
}

say(`Throwaway wallet ${ME} (seed in memory only). Signer: the real class, state in a temporary directory.`);
say('\n1. What the signer refuses');
await refused('another destination', sign(withdrawal('testnet', { destination: `0x${'ab'.repeat(20)}` })), /wrong_destination/);
await refused('amount equal to the fee', sign(withdrawal('testnet', { amount: '1' })), /greater than the venue's withdrawal fee/);
await refused('no passkey', signer.venueWithdraw(withdrawal('testnet'), undefined), /bad_approval/);
{ const w = withdrawal('testnet'); await refused('passkey over another amount', signer.venueWithdraw(w, pk.assert(venueWithdrawalHash({ ...w, amount: '99' }))), /bad_approval/); }

say('\n2. What it signs, verified by recovering the signer from the typed data');
const out: Record<string, { action: unknown; signature: unknown; nonce: number }> = {};
for (const network of ['testnet', 'mainnet'] as const) {
  const w = withdrawal(network), r = await sign(w);
  const td = buildWithdraw3TypedDataOnly({ network, destination: r.action.destination, amount: r.action.amount, time: r.action.time }).typedData;
  const who = await recoverTypedDataSigner(td, r.signature);
  check(who === ME && r.action.destination === ME && r.action.type === 'withdraw3' && r.action.hyperliquidChain === (network === 'mainnet' ? 'Mainnet' : 'Testnet') && r.action.signatureChainId === '0x66eee' && r.nonce === r.action.time,
    `${network}: withdraw3 ${JSON.stringify(r.action)} — signature recovers to ${who}${network === 'mainnet' ? ' (NOT sent anywhere)' : ''}`);
  await refused(`${network}: the same withdrawal again`, sign(w), /replay/);
  out[network] = { action: r.action, signature: r.signature, nonce: r.nonce };
}

if (SEND) {
  say(`\n3. The TESTNET signature posted to ${TESTNET}/exchange (unfunded throwaway account: a refusal is the expected answer)`);
  const body = { action: out.testnet!.action, nonce: out.testnet!.nonce, signature: out.testnet!.signature, vaultAddress: null, expiresAfter: null };
  const res = await fetch(`${TESTNET}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  say(`  HTTP ${res.status} ${text}`);
  let answer: { status?: string; response?: unknown } = {}; try { answer = JSON.parse(text); } catch { /* shown as text */ }
  check(res.status === 200 && answer.status === 'err' && String(answer.response).toLowerCase().includes(ME), 'the venue refused and named OUR address: it recovered the wallet key from the signature over ITS hash of the action');
  if (RECORD) {
    const file = new URL('../packages/derivatives/test/fixtures/hyperliquid/testnet-withdraw-proof.json', import.meta.url);
    writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), network: 'testnet', endpoint: `${TESTNET}/exchange`, account: ME, note: 'throwaway key generated in memory; account never deposited', request: body, status: res.status, answer }, null, 1) + '\n');
    say(`  recorded: ${file.pathname}`);
  }
} else say('\n3. Not sent (run with --send to post the TESTNET signature to the testnet exchange endpoint).');
say(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`} The mainnet exchange endpoint was never contacted.`);
process.exit(failures ? 1 : 0);
