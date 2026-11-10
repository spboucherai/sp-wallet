import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { p2wpkh, NETWORK } from '@scure/btc-signer';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import Slip10 from 'micro-key-producer/slip10.js';
import { privateKeyToAccount } from 'viem/accounts';

export const PATHS = { evm: "m/44'/60'/0'/0/0", btc: "m/84'/0'/0'/0/0", sol: "m/44'/501'/0'/0'" } as const;

export interface Keys {
  keyId: string;
  addresses: { evm: string; btc: string; sol: string };
  evmPriv: Uint8Array; btcPriv: Uint8Array; solSeed: Uint8Array;
}

/** Standard derivations: BIP-44 (EVM), BIP-84 native SegWit (BTC), SLIP-0010 ed25519 (Solana). One curve per path. */
export function deriveKeys(mnemonic: string): Keys {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid mnemonic');
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const evmPriv = root.derive(PATHS.evm).privateKey, btcNode = root.derive(PATHS.btc);
  if (!evmPriv || !btcNode.privateKey || !btcNode.publicKey) throw new Error('derivation failed');
  const solSeed = Slip10.fromMasterSeed(seed).derive(PATHS.sol).privateKey;
  const evm = privateKeyToAccount(`0x${Buffer.from(evmPriv).toString('hex')}`).address;
  const btc = p2wpkh(btcNode.publicKey, NETWORK).address;
  if (!btc) throw new Error('btc address derivation failed');
  const sol = base58.encode(ed25519.getPublicKey(solSeed));
  const keyId = 'spw-' + Buffer.from(sha256(new TextEncoder().encode(`${evm}|${btc}|${sol}`))).toString('hex').slice(0, 16);
  return { keyId, addresses: { evm, btc, sol }, evmPriv, btcPriv: btcNode.privateKey, solSeed };
}
