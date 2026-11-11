import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { p2pkh, p2wpkh } from '@scure/btc-signer';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import Slip10 from 'micro-key-producer/slip10.js';
import { privateKeyToAccount } from 'viem/accounts';
import { btcParams, NETWORKS, pluginFor, type KeyHandle, type NetworkDef } from '@spw/core';

export const PATHS = { evm: "m/44'/60'/0'/0/0", btc: "m/84'/0'/0'/0/0", sol: "m/44'/501'/0'/0'" } as const;
/** BIP-84 for native SegWit chains, BIP-44 for legacy P2PKH chains; coin type from the registry. */
export const utxoPath = (n: NetworkDef) => `m/${n.utxo?.kind === 'pkh' ? 44 : 84}'/${n.coinType ?? 0}'/0'/0/0`;

export interface Keys {
  keyId: string;
  /** address per network id (plus the legacy family keys evm/btc/sol) */
  addresses: Record<string, string> & { evm: string; btc: string; sol: string };
  evmPriv: Uint8Array; solSeed: Uint8Array;
  /** secp256k1 private key of a Bitcoin-style network */
  utxoPriv(n: NetworkDef): Uint8Array;
  /** EVM key of an agent vault: HD account `index` ≥ 1 (account 0 is the owner's wallet) */
  vault(index: number): { priv: Uint8Array; address: string };
  /** signing handle for a plugin family network; the plugin never sees the private key */
  handle(n: NetworkDef): KeyHandle;
}

/** Standard derivations: BIP-44 (EVM), BIP-84/44 (UTXO chains), SLIP-0010 ed25519 (Solana and ed25519 plugins). One curve per path. */
export function deriveKeys(mnemonic: string): Keys {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid mnemonic');
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const secp = (path: string) => { const k = root.derive(path); if (!k.privateKey || !k.publicKey) throw new Error('derivation failed'); return { priv: k.privateKey, pub: k.publicKey }; };
  const ed = (path: string) => { const priv = Slip10.fromMasterSeed(seed).derive(path).privateKey; return { priv, pub: ed25519.getPublicKey(priv) }; };
  const evmPriv = secp(PATHS.evm).priv, solSeed = ed(PATHS.sol).priv;
  const evm = privateKeyToAccount(`0x${Buffer.from(evmPriv).toString('hex')}`).address;
  const sol = base58.encode(ed25519.getPublicKey(solSeed));
  const utxoAddr = (n: NetworkDef) => { const { pub } = secp(utxoPath(n)); const a = (n.utxo!.kind === 'pkh' ? p2pkh(pub, btcParams(n)) : p2wpkh(pub, btcParams(n))).address; if (!a) throw new Error('address derivation failed'); return a; };
  const handle = (n: NetworkDef): KeyHandle => {
    const p = pluginFor(n);
    if (p.curve === 'secp256k1') {
      const { priv, pub } = secp(p.path(n));
      return { curve: 'secp256k1', publicKey: pub, signDigest: (digest) => {
        if (digest.length !== 32) throw new Error('digest must be 32 bytes');
        const sig = secp256k1.sign(digest, priv, { prehash: false, lowS: true, format: 'recovered' }); // [recovery, r, s]
        const compact = sig.slice(1);
        return { compact, recovery: sig[0]!, der: secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der') };
      } };
    }
    const { priv, pub } = ed(p.path(n));
    return { curve: 'ed25519', publicKey: pub, signMessage: (m) => ed25519.sign(m, priv) };
  };
  const addresses = { evm, sol, btc: '' } as Record<string, string> & { evm: string; btc: string; sol: string };
  for (const n of Object.values(NETWORKS) as NetworkDef[]) {
    if (n.family === 'evm') addresses[n.id] = evm;
    else if (n.family === 'sol') addresses[n.id] = sol;
    else if (n.family === 'btc') addresses[n.id] = utxoAddr(n);
    else { const p = pluginFor(n); addresses[n.id] = p.address(n, handle(n).publicKey); }
  }
  addresses.btc = addresses.bitcoin!;
  if (!addresses.btc) throw new Error('bitcoin address missing');
  // the key id stays bound to the three original addresses so it does not change when networks are added
  const keyId = 'spw-' + Buffer.from(sha256(new TextEncoder().encode(`${evm}|${addresses.btc}|${sol}`))).toString('hex').slice(0, 16);
  const vault = (index: number) => {
    if (!Number.isInteger(index) || index < 1 || index > 100_000) throw new Error('vault index out of range');
    const priv = secp(`m/44'/60'/${index}'/0/0`).priv;
    return { priv, address: privateKeyToAccount(`0x${Buffer.from(priv).toString('hex')}`).address };
  };
  return { keyId, addresses, evmPriv, solSeed, utxoPriv: (n) => secp(utxoPath(n)).priv, handle, vault };
}
