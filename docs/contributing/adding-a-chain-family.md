# Adding a chain family (contract for implementers)

SP Wallet moves real funds. A chain integration is accepted only if the signer can rebuild the exact transaction from the
approved intent, refuses everything else, and the result is proven against an independent implementation.

## Read first
- `packages/core/src/families.ts` — the `FamilyPlugin` contract and `KeyHandle`.
- `packages/core/src/intent.ts` — the approved intent. Plugin families put their chain parameters in `x` (flat string map) and may use `memo`.
- `packages/core/src/build-sol.ts` + `services/api/src/chains/sol.ts` — a complete built-in example (deterministic builder, adapter).
- `services/api/src/chains/rpc.ts` — the `Adapter` interface, `rpcAny` (failover, display only), `rpcQuorum` (all sources must agree).
- `services/api/src/chains/btc.ts` — two-source agreement before preparing a transfer.
- `packages/core/test/core.test.ts`, `services/isolated-signer/test/signer.test.ts` — the style of tests expected.

## What to deliver
1. `packages/core/src/plugins/<family>.ts` exporting a `FamilyPlugin` object (pure module: no network access, no side effects).
   - `build()` rebuilds the transaction from the intent only and returns the exact bytes/digests to sign. It must throw on: wrong
     chain id / genesis, non-normalized or invalid addresses, an asset that is not the native coin or an allowlisted token, a fee
     above `intent.maxFee`, unknown or missing `x` keys, any amount ≤ 0, destination equal to source.
   - `sign()` uses only the `KeyHandle` (never raw private keys) and returns the broadcast-ready payload and the transaction id.
   - Only two shapes: native transfer, and (where listed in the task) one allowlisted token transfer. No arbitrary calls.
2. Registration: add the network(s) to `DEFS` in `packages/core/src/networks.ts` (`family`, `coinType`, `chainRef` = the chain's
   genesis/network identifier, `memo`, `activation`, `rpc` with **two independent keyless public sources**, explorers, `minConf`),
   register the plugin in `packages/core/src/plugins/index.ts` (create it if missing; it must be imported by `packages/core/src/index.ts`),
   add the native symbol to `CAPS` (≈ 50 USD worth) and a fee ceiling to `STABLE_FEE` in `packages/core/src/policy.ts`,
   and register the API adapter factory in `services/api/src/chains/index.ts`.
3. `services/api/src/chains/<family>.ts` exporting `<family>Adapter(n: NetworkDef): Adapter`:
   - `health()`: both sources up + chain identity verified (genesis hash / network id) → `ok`; at least one up → `readable`.
   - `balances()`, `deposits()` (incoming transfers, finalized only), `track()` (broadcast → confirming → finalized, with
     `failed` / expiry handled; a returned hash is never success), `broadcast()` (to all sources; "already known" is success).
   - `prepare()`: every value that feeds the signature (sequence/nonce, reference block, account existence, fee) must be read with
     agreement of both sources or fail closed with `UserError('rpc_degraded' | 'rpc_disagreement', …, 503)`; check balance covers
     amount + fee + any reserve the chain requires; simulate when the chain offers it; return `{ section: { x: {...} }, maxFee, feeEstimate, warnings, ttlSec, aux? }`.
4. Tests (vitest) in `packages/core/test/<family>.test.ts`:
   - address derivation from the public BIP-39 test mnemonic `abandon ×11 about` against a published vector or the official SDK;
   - the built transaction decoded/re-encoded **by the chain's official SDK** (devDependency) must be byte-identical or field-identical;
   - the signature verifies with the official SDK or noble against the public key;
   - every fail-closed case above; changing any intent field changes the signed bytes or throws.
   Plus one signer-level test in `services/isolated-signer/test/` signing an intent through `Signer` (see existing tests).
5. `scripts/smoke-<family>.mts`: live **read-only** check against mainnet (health, identity, balance of a well-known address,
   `prepare()` for a funded public address to prove the two sources agree). Run it and include the output in your report.

## Rules
- Never broadcast, never use real keys, never touch any keystore or the production nodes. Tests use the public test mnemonic only.
- Money is `bigint` base units end to end. No floating point.
- Prefer `@noble/*` and `@scure/*` (already present) for primitives. A runtime dependency is acceptable only if it is the chain's
  official, maintained encoder, pure JavaScript (the services are bundled with esbuild; no WASM, no native addons). Pin exact versions.
- `pnpm install`, `pnpm typecheck` and `npx vitest run` must pass; `node scripts/build.mjs` must still bundle.
- Commit on a branch `wave3-<family>` in your worktree (do not push). Do not modify unrelated code; if the contract itself is
  insufficient, say so in the report instead of working around it.
- Report: what is implemented, the published vectors/SDK checks used, live smoke output, residual risks and anything unverified.
