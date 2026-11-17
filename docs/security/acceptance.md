# Deviations from the master specification, and why

The owner asked on 2026-11-10 for mainnet from day one, single user, small balances, in one pass. Consequently:

| Specification | What was built | Reason |
|---|---|---|
| testnets first, mainnet after gates | the WALLET's networks (transfers, swaps, bridges, spot agents) are mainnet only; derivatives are the exception since v4: a Hyperliquid venue account can be on the venue's **testnet**, the mainnet derivative paths are behind server locks that are off by default, and the go-live paths of V11 ask for a testnet step first (`docs/TRADING-PRODUCTION-READINESS.md` §4). *(Corrected 2026-11-17: this row said "mainnet only" — audit B-12.)* | owner instruction |
| independent audit / pentest before live value | not done | owner accepted for ≤ tens of USD; limits enforce it |
| Next.js App Router | Vite + React SPA served by the API | no inline scripts → strict `script-src 'self'` CSP; smaller dependency surface |
| Rust signer | TypeScript signer on audited noble/scure primitives | one pass; same libraries verify test vectors |
| many micro-services (indexer, broadcaster, approvals, gateway) | two processes: API (with worker) and signer | the trust boundary that matters is API ↔ signer |
| Bitcoin Core descriptors + PSBT | Esplora indexers (two, must agree) + @scure/btc-signer | no full node on the cluster; signer still verifies every input/output |
| OCI images, mTLS, VLAN | PM2 processes; HMAC + source-IP allowlist on LAN | existing MacLustr deployment model |
| Redis, OpenAPI document, roles (viewer/operator/…) | none | single owner |
| second approver for large amounts | none; per-transfer cap instead | single owner |
| service worker / offline mode | none (installable PWA manifest only) | avoids caching anything sensitive |
| un-halt from the app | signer CLI only | a compromised app must not be able to resume signing |
| incoming native ETH/POL deposits in Activity | balance only (USDC, BTC, SOL deposits are listed) | needs a tracing indexer |
