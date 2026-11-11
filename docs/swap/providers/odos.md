# Odos — provider dossier

**Status on 2026-11-10: not integrated. Odos permanently shut down its quoting and routing API on 2026-07-30.**
There is no adapter, no registration and no fixture: there is no live API to record from, and its documentation site is offline too, so
an adapter could only have been written from memory — which the provider contract forbids ("never fabricate a route").

## Evidence
Official site, https://odos.xyz/ (title "Odos Shutdown Information", read 2026-11-10):
- "Odos trading and API services have shut down" — "Odos is no longer accepting new trades or enterprise API requests. This site will remain
  available for shutdown details and information about deployed contracts and programs."
- Status table: Trading **Offline**, Enterprise API **Offline**, wallet recovery available.
- Dates: **2026-07-23** public announcement (https://x.com/odosprotocol/status/2080337624922018014), new enterprise registrations ended;
  **2026-07-27** "New swaps, orders, bridges, and relayed transactions ended"; **2026-07-30** "Enterprise API and backend shutdown —
  Production API access ended. Enterprise API keys were disabled. Remaining trading and account services were retired."
- FAQ: "Can I still trade through Odos? No. Odos no longer provides quotes, routing, swaps, limit orders, bridges, gasless execution, or
  transaction submission."

Live probe (`scripts/smoke-swap-odos.mts`, 2026-11-11T01:08Z):

| Endpoint | Answer |
|---|---|
| `https://api.odos.xyz/info/chains`, `/info/router/v2/1`, `/sor/quote/v3` | HTTP 530 (Cloudflare error 1033: origin gone) |
| `https://enterprise-api.odos.xyz/info/chains` | HTTP 403 `{"error":"No API key provided"}` (keys are disabled) |
| `https://docs.odos.xyz/` | HTTP 530 |

Consequences for the questions asked of this provider — endpoints, key requirement, rate limits, native-coin convention, slippage and
minimum output, gas, price impact, quote validity: **none can be answered from a current official source**, because the API and its
documentation no longer exist. Nothing is asserted here from older knowledge.

## Contracts that remain on chain (official site, section "On-chain contracts and programs")
The site lists them as public records and marks every one **unsupported** or **historical**:
"Some on-chain code may remain callable, but availability does not imply that Odos operates, monitors, or supports it."

- Smart Order Router **V3** — "uses the same address on every supported EVM network": `0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05` (unsupported).
- Smart Order Router **V2** — "Archived V2 smart-order-routing deployments retained for public reference" (historical):

| Network | V2 router | Network | V2 router |
|---|---|---|---|
| Ethereum | `0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559` | Arbitrum | `0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13` |
| Base | `0x19cEeAd7105607Cd444F5ad10dd51356436095a1` | Optimism | `0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680` |
| Polygon PoS | `0x4E3288c9ca110bCC82bf38F09A7b425c095d92Bf` | BNB Chain | `0x89b8AA89FDd0507a99d334CBe3C808fAFC7d850E` |
| Avalanche | `0x88de50B233052e4Fb783d4F6db78Cc34fEa3e9FC` | HyperEVM | not listed |

(The site also lists Sonic, Fantom, Fraxtal, zkSync Era, Mantle, Mode, Linea, Scroll, Unichain, and the former limit-order routers; none
is relevant to the wallet.)

These addresses must **not** be used for execution: a router without its off-chain pathfinder cannot produce a route, and an unmaintained
router is exactly the kind of contract the wallet should not grant allowances to. If any wallet address ever approved an Odos router, revoking
that allowance is prudent — outside the scope of this work.

## If Odos comes back
The Odos DAO is reported to be separate from the company; no relaunch is announced. Should an official API reappear:
1. `npx tsx scripts/smoke-swap-odos.mts` exits 1 as soon as an endpoint answers again.
2. Start from the then-current official documentation — do not assume the former API, routers or key rules still apply.
3. Follow `docs/swap/adding-a-provider.md` from scratch (adapter, recorded fixtures, smoke, this dossier rewritten).

Beware of impostors: any site, account or "migration" offering Odos swaps today is not Odos.
