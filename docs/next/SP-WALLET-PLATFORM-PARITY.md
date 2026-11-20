# SP Wallet NEXT — platform parity

**One wallet, three native experiences, one source of truth.** Every figure below comes from the same server routes
(`SP-WALLET-API.md`); the two Apple apps share one Swift package for the API client, the approval rules, the design
tokens and the components. State at release 2026-11-20: web deployed, macOS 2.0.0 (2) notarised, iOS 2.0.0 (4) on TestFlight.

✓ = present and exercised (tests, a browser or a simulator; see `SP-WALLET-TEST-REPORT.md` for which) · ◐ = present with
the limit noted · — = absent on that platform, by design or not built.

| Feature | Web | macOS | iOS / iPadOS | Notes |
|---|---|---|---|---|
| **Dashboard** | | | | |
| Total value from the server, partial said plainly | ✓ | ✓ | ✓ | `summary.total / complete / missing` |
| Change (absolute + %, period named) | ✓ | ✓ | ✓ | 24 h on the card; over the range under the chart |
| Value history 1D · 1W · 1M · 3M · 1Y · ALL | ✓ | ✓ | ✓ | starts on release day: no back-fill |
| Flows marked, estimate never called a return | ✓ | ✓ | ✓ | |
| Allocation by asset / by network | ✓ | ✓ | ✓ | bar + legend everywhere |
| Recent activity | ✓ | ✓ | ✓ | |
| Fees paid, inflow / outflow tiles | ✓ | ✓ | ✓ | "network fee now" tile: not built (no source) |
| Alerts strip | ✓ | ✓ | ✓ | |
| Quick send / receive | ✓ | ✓ | ✓ | iOS adds Scan |
| **Assets** | | | | |
| List, network badge, contract, explorer | ✓ | ✓ | ✓ | |
| Search (name, symbol, network, contract) | ✓ | ✓ | ✓ | |
| Hide / favourite, synced | ✓ | ✓ | ✓ | server preferences |
| Custom tokens | — | — | — | by decision: verified registry only |
| Unverified-token marking | — | — | — | nothing unverified can enter the registry |
| **Send / receive** | | | | |
| Validation per network | ✓ | ✓ | ✓ | server rule; Core validator on Apple |
| Review of every signed field | ✓ | ✓ | ✓ | Apple: generated from the canonical object |
| Warnings with acknowledgement (new destination, poisoning, duplicate) | ✓ | ✓ | ◐ | iOS: on Send; Swap shows warnings without the checkbox |
| Lost-answer handling ("status unknown — do not send again") | ✓ | ✓ | ✓ | Apple: send, swap, bridge, plans, NFT; futures / mandates keep their own flow |
| Life-cycle tracker (14 values, one vocabulary) | ✓ | ✓ | ✓ | |
| Max, fiat equivalent, contact picker | ✓ | ✓ | ◐ | iOS Max fills the balance, then offers the fee adjustment |
| Receive: QR, copy, share, payment link | ✓ | ✓ | ✓ | |
| QR scan | — | — | ✓ | camera: device only |
| **Activity** | | | | |
| History with pagination | ✓ | ◐ | ✓ | macOS: "load more" up to 500 rows (cursor not yet used) |
| Detail: hash copy, explorer, confirmations, fee paid | ✓ | ✓ | ✓ | fee paid recorded from release on |
| Dropped / replaced / expired explained, "still watched" | ✓ | ✓ | ✓ | |
| Contact labels, internal deposits folded | ✓ | ✓ | ✓ | |
| Export CSV | ✓ | ✓ | ✓ | macOS also PDF |
| **Contacts** | ✓ | ✓ | ✓ | add, edit, favourite, delete, guarded address change |
| **Security Center** | | | | |
| Passkeys from the signer's list, mismatch warning | ✓ | ✓ | ✓ | |
| Add / revoke a passkey | ✓ | ✓ | ✓ | never exercised with a real second passkey yet |
| Sessions: current marked, revoke one / all | ✓ | ✓ | ✓ | |
| Last sign-ins, recovery status, limits (read-only) | ✓ | ✓ | ✓ | |
| Emergency halt | ✓ | ✓ | ✓ | |
| **Sync** | | | | |
| Live from the wallet event stream, resume, fallback polling | ✓ | ✓ | ✓ | iOS: while the app is in the foreground |
| Settings, appearance, hidden assets, contacts follow the account | ✓ | ✓ | ✓ | |
| **Notifications** | | | | |
| Transfer confirmed / failed / dropped / replaced / expired / recovered, deposits, security | ✓ Web Push | ◐ local, while the app runs (also in the background) | ◐ local, while the app is open | no APNs in this release (owner decision pending) |
| **Search** | ✓ ⌘K | ✓ ⌘K, ⌘F | ✓ search field / sidebar | |
| **Authentication** | WebAuthn | Touch ID passkey | Face ID passkey | |
| App lock | — | ✓ every window, sleep, screen lock | ✓ over sheets, delay setting | |
| Privacy cover / hidden balances | hide balances | hide balances | cover in the app switcher, widgets gated | |
| **Platform** | | | | |
| Light / dark / system | ✓ | ✓ | ✓ | |
| Languages | FR, EN | FR, EN (EN not proof-read on screen) | FR, EN | |
| Text scaling | ✓ to 200 % | ◐ three-step setting (macOS has no Dynamic Type) | ✓ Dynamic Type to AX3 on core screens | |
| Multiple windows, menus, context menus, drag | browser | ✓ | iPad: one router per scene | |
| Widgets | — | — | ✓ | device only |
| Haptics | — | — | ✓ | device only |
| Extended areas (swap, bridge, plans, NFT, futures, agents, research, alerts, risk, developer) | ✓ | ✓ | ✓ | inherit the new tokens; not redesigned one by one |

## Differences kept on purpose

Navigation (sidebar and windows on the Mac, tabs on the phone, sidebar on the iPad), unlock (Touch ID, Face ID, WebAuthn),
the scanner (phone and tablet), widgets and haptics (iOS), menus and drag (macOS), Web Push (web).

## Gaps to close

1. Notifications when the native apps are closed: needs APNs (an Apple push key and a server sender).
2. macOS activity on the cursor route; iOS acknowledgement checkbox in Swap; row-level fiat through exact values
   (today a labelled approximation; totals are exact).
3. Futures, mandates, risk limits and API keys on the shared outcome helper in the Apple apps.
4. On a real device, with the owner: passkeys, locks, widgets, notifications, two devices synchronising.
