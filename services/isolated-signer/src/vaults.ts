// The signer's own view of THORChain's vault set, used for native cross-chain swaps (packages/core/src/thorchain.ts).
// A THORChain swap pays an Asgard vault whose address only the network's nodes can name. The API proposes one; before signing,
// the signer asks several independently operated THORNodes ITSELF — its own compiled-in list, over TLS, nothing passing
// through the API — and signs only if every operator that answers confirms the vault (checkThorVault). A compromised API
// therefore cannot substitute its own address. Any doubt — too few answers, one dissenting, a halted chain — means no signature.
// Nothing is cached: every signature is checked against the operators' current state.
import { checkThorVault, fetchThorViews, THORNODE_OPERATORS, type ThorGet, type ThorVaultVerdict, type ThorVaultWant } from '@spw/core';

export interface VaultView { /** throws unless the vault is confirmed */ check(want: ThorVaultWant): Promise<ThorVaultVerdict> }

const TIMEOUT_MS = 7000, MAX_BYTES = 400_000;
const json: ThorGet = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'vault-check', 'x-client-id': 'vault-check' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  if (t.length > MAX_BYTES) throw new Error('response too large');
  return JSON.parse(t);
};
/** Hosts this view contacts (documented in docs/swap/providers/thorchain.md; an egress allowlist must include them). */
export const vaultHosts = (): string[] => THORNODE_OPERATORS.map((o) => new URL(o.base).host);

export function thorVaults(get: ThorGet = json): VaultView {
  return { async check(want) { return checkThorVault(await fetchThorViews(get), want); } };
}
/** For tests and CLI paths: no view, so every cross-chain swap is refused. */
export const noVaults: VaultView = { check: async () => { throw new Error('no vault view configured'); } };
