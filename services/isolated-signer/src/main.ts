// SP Wallet isolated signer — CLI + daemon. Holds the only copy of signing keys.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import dns from 'node:dns';
import net from 'node:net';
import { deriveKeys } from './keys.ts';
import { exchangePrices } from './prices.ts';
import { hyperliquidReader } from './venue-read.ts';
import { initKeystore, loadMnemonic } from './keystore.ts';
import { applyControl, controlCall, startControlServer, type ControlRequest } from './control.ts';
import { createQueue, createSignerServer } from './server.ts';
import { Signer } from './signer.ts';
import { acquireStateLock, Store, StoreLockedError } from './store.ts';
import { thorVaults } from './vaults.ts';

const dir = process.env.SPW_SIGNER_DIR ?? join(homedir(), 'sp-wallet-signer-data');
const wrapKey = process.env.SPW_SIGNER_WRAP_KEY ?? join(homedir(), '.config', 'sp-wallet-signer', 'wrap.key');
const paths = { keystore: join(dir, 'keystore.json'), state: join(dir, 'state.json'), policy: join(dir, 'policy.json'), secret: join(dir, 'gateway.secret'), control: join(dir, 'control.sock') };
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2); } return v; };
process.umask(0o077);

const cmd = process.argv[2] ?? 'serve';
const open = () => {
  const keys = deriveKeys(loadMnemonic(paths.keystore, wrapKey));
  const store = new Store(paths.state, paths.policy);
  return { keys, store };
};
/**
 * V11: a command that changes the state. A running daemon applies it itself (control.ts) — the change is then in force at once
 * and cannot be undone by the daemon's next save. Without a daemon, this process takes the state lock and writes the file.
 */
async function change(req: ControlRequest): Promise<{ halted: boolean; via: 'daemon' | 'file' }> {
  let a = await controlCall(paths.control, req).catch((e: Error) => { console.error(e.message); process.exit(1); });
  if (a === null) {
    let release: () => void;
    try { release = acquireStateLock(paths.state); }
    catch (e) { console.error(e instanceof StoreLockedError ? `${e.message}: the daemon is running but its control socket (${paths.control}) did not answer; nothing was changed` : (e as Error).message); process.exit(1); }
    try { a = applyControl(new Store(paths.state, paths.policy), req, 'file'); } finally { release(); }
  }
  if (!a.ok) { console.error(a.error); process.exit(1); }
  return a;
}

if (cmd === 'init') {
  initKeystore(paths.keystore, wrapKey);
  const { keys } = open();
  console.log(JSON.stringify({ ok: true, keyId: keys.keyId, addresses: keys.addresses }, null, 2));
  console.log('Keystore created. The recovery phrase was NOT displayed. Run `export-recovery` yourself in a private terminal and write it on paper.');
} else if (cmd === 'setup-token') {
  const token = randomBytes(18).toString('base64url');
  await change({ cmd: 'setup-token', tokenHash: createHash('sha256').update(token).digest('hex') });
  console.log(token);
} else if (cmd === 'status') {
  const { keys, store } = open();
  const s = new Signer(keys, store, { rpId: 'unused', origin: 'unused' }).status();
  console.log(JSON.stringify({ ...s, journalIntact: store.journalBrokenAt === null }, null, 2));
} else if (cmd === 'halt' || cmd === 'unhalt') {
  const r = await change({ cmd });
  console.log(`halted=${r.halted} (${r.via === 'daemon' ? 'applied by the running daemon: in force now' : 'no daemon is running: written to the state file'})`);
} else if (cmd === 'reset-passkeys') {
  const r = await change({ cmd: 'reset-passkeys' });
  console.log(`all passkeys removed (${r.via === 'daemon' ? 'applied by the running daemon' : 'no daemon is running: written to the state file'}); issue a new setup-token`);
} else if (cmd === 'export-recovery') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('export-recovery only runs in an interactive terminal (never piped, logged or run by an agent)'); process.exit(1); }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question('This prints the 24-word recovery phrase. Nobody is watching, no screen sharing, no AI session? Type SHOW: ');
  rl.close();
  if (a.trim() !== 'SHOW') process.exit(1);
  const words = loadMnemonic(paths.keystore, wrapKey).split(' ');
  console.log('\n' + words.map((w, k) => `${String(k + 1).padStart(2)}. ${w}`).join('\n') + '\n\nWrite it on paper, store it offline, then clear this terminal (Cmd-K).');
} else if (cmd === 'serve') {
  if (!existsSync(paths.keystore)) { console.error('no keystore: run `init` first'); process.exit(1); }
  // the daemon owns the state for its whole life: a second daemon, or a CLI command writing under it, is refused
  let release: () => void;
  try { release = acquireStateLock(paths.state); } catch (e) { console.error((e as Error).message); process.exit(1); }
  process.on('exit', () => release());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
  const { keys, store } = open();
  const broken = store.journalBrokenAt;
  if (broken !== null) { console.error(`signer journal hash chain broken at seq ${broken} — refusing to start`); process.exit(1); }
  const secret = existsSync(paths.secret) ? readFileSync(paths.secret, 'utf8').trim() : need('SPW_SIGNER_SECRET');
  // outbound HTTPS is used for two things only: reading public exchange prices to check agent orders and live venue orders, and —
  // for derivative mandates — reading the venue account (positions, account value, resting orders) from the venue's public info
  // endpoint (venue-read.ts: POST /info, no key). The signer never calls a venue's trading endpoint: the API sends what it signs.
  dns.setDefaultResultOrder('ipv4first'); net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
  const signer = new Signer(keys, store, { rpId: need('SPW_RP_ID'), origin: need('SPW_ORIGIN') }, undefined, exchangePrices(), hyperliquidReader(),
    thorVaults()); // further outbound use: asking independent THORNode operators whether a vault is genuine before signing a cross-chain swap (vaults.ts)
  const host = process.env.SPW_SIGNER_HOST ?? '127.0.0.1', port = Number(process.env.SPW_SIGNER_PORT ?? 8651);
  const allowed = (process.env.SPW_SIGNER_ALLOW_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const enqueue = createQueue();
  // the operator's commands (halt, unhalt, reset-passkeys, setup-token) reach the running daemon through a socket in its own directory
  startControlServer(paths.control, (req) => enqueue(() => applyControl(store, req, 'daemon')));
  createSignerServer(signer, secret, allowed, enqueue).listen(port, host, () => console.log(`signer ${keys.keyId} listening on ${host}:${port} halted=${store.state.halted}`));
  process.on('uncaughtException', (e) => { console.error('fatal:', e.message); process.exit(1); });
} else {
  console.error('usage: signer init | setup-token | status | serve | halt | unhalt | reset-passkeys | export-recovery');
  process.exit(2);
}
