# Venue terms and the owner's jurisdiction (Québec, Canada)

Read live on 2026-11-10. General information, not legal advice. The owner decides; the software does not work around any
access restriction (no VPN, no proxy, no alternative data path to a blocked service).

| Venue | Terms name Canada / Québec | Scope of the terms | Effect in SP Wallet |
|---|---|---|---|
| dYdX v4 | Canada excluded ("NOT AVAILABLE TO … THE UNITED STATES OF AMERICA, CANADA AND THE UNITED KINGDOM", v4 terms, 2026-03-12); VPN circumvention prohibited; the mainnet indexer answers account endpoints with `GEOBLOCKED` from the owner's network | interface and indexer | market data only; no account, no trading |
| edgeX (Perps V2) — added 2026-11-15 (V11) | Canada excluded: "THE edgeX INTERFACE … IS NOT AVAILABLE TO PERSONS OR ENTITIES WHO RESIDE IN, ARE LOCATED IN, ARE INCORPORATED IN, OR HAVE A REGISTERED OFFICE IN THE UNITED STATES OF AMERICA OR CANADA (COLLECTIVELY, "BLOCKED PERSONS") … WE DO NOT MAKE EXCEPTIONS … USE OF A VIRTUAL PRIVATE NETWORK ("VPN") TO CIRCUMVENT THE RESTRICTIONS SET FORTH HEREIN IS PROHIBITED."; §12.1: "no Blocked Person may enter into Perpetual Contracts using the Services" (Terms of Use, <https://edgex-1.gitbook.io/edgeX-documentation/about/terms-of-use>, help-center copy last updated 2026-10-04, read 2026-11-15). Québec is not named separately; it is covered by "Canada" | the interface, and through §12.1 perpetual contracts "using the Services" (so calling the API directly does not obviously escape it — a reading of the text, not legal advice). Public REST and websocket market data answered from a Canadian IP on 2026-11-15: a technical observation, not a permission | market data only; no account, no private endpoint, no order code, no paper account (reason codes `edgex_trading_restricted_jurisdiction`, `edgex_account_restricted_jurisdiction`; constant `EDGEX_BLOCKED_JURISDICTION` in `packages/derivatives/src/live/jurisdiction.ts`) |
| Hyperliquid | "United States of America or Ontario, Canada" (§1.6, terms of app.hyperliquid.xyz, last updated 2026-06-15). Québec is not named | the website interface (app.hyperliquid.xyz); §1.1 says the interface is not the exclusive means of access; no API terms or documented API geo-blocking were found | read + paper now; live trading is the owner's decision (see below) |
| GMX v2 | Canada not named; U.S. persons and sanctioned territories excluded; "Applicable Laws" clause (1.1.8) puts compliance with the user's own federal/provincial law on the user (terms of gmx.io / app.gmx.io, last modified 2026-08-20) | site and interface (the contracts are permissionless) | read; trading built in v8 (2026-11-11), **off** until two server settings are on and the owner approves a venue policy with this acknowledgement (see below) |

Regulator context (Canada): the AMF's public page on buying and selling crypto says platforms letting Québec clients trade
crypto assets that are securities or derivatives must be registered with the AMF and advises against dealing with platforms
that are neither registered nor under a pre-registration undertaking; neither Hyperliquid nor GMX is on the AMF's register of
crypto trading platforms (checked 2026-11-10). CSA Staff Notice 21-332 (2023) requires registered/undertaking platforms not to
offer leverage to Canadian clients. Hyperliquid's own terms (§1.9) make the user solely responsible for determining whether
leveraged or derivative trading is lawful where he lives.

Not verified: the AMF's own warning list could not be searched (only its first page loaded); whether either interface blocks a
Québec IP in practice; the Hyperliquid order endpoint was never called on mainnet.

Consequence for the build: everything up to paper trading is unaffected. Before any live derivative order is enabled, the UI
shows this page's summary and the owner confirms the decision explicitly (it is recorded in the audit log).

## edgeX (added 2026-11-15, V11)

Same rule as dYdX: a venue whose terms name Canada as blocked is integrated for its public market data only, and nothing
works around the restriction. There is no acknowledgement text for edgeX in `JURISDICTION_ACK` — there is nothing the owner
could approve. Trading on edgeX appears in the product as unavailable, with this reason, in French and in English; it is
never simulated. Details, sources and what would have to change: `docs/V11-EXCHANGE-INTEGRATIONS.md` (edgeX chapter) and
`docs/v11/research/edgex-api.md` §6.4.
