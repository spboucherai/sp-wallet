# V9 design pass — before / after

Every screen was captured before and after, phone (390 × 844 at 3×, stored 600 px wide) and desktop (1440 × 900), light
and dark, in French: `docs/v9/screens/before/` and `docs/v9/screens/after/`, named `<screen>-<phone|desktop>-<light|dark>.webp`
(`-full` = the whole page on a phone). The logo sheets are in `docs/v9/logo-wall/`. The system is described in `DESIGN.md`.

How the pictures were made (`tests/e2e/v9-shots.mts`): the wallet is the throwaway one of the local QA stack
(`tests/e2e/qa-real-server.mts`: in-memory seed, broadcast off, local forks for balances). "Before" is the bundle of `main`
on 2026-11-11. For "after", Swap, Agents, Futures, Alerts, Monitor, Research and the lock screen come from the live stack;
Home, Assets, Asset, Receive, Send, Activity, Settings and Security were re-captured with the API replayed from answers
recorded on that stack earlier the same day (`V9_REPLAY=1`), because the public RPC behind the local forks stopped
answering balance reads in the evening. `send-review` is from the live stack, taken before the last cosmetic changes.

## Phone, light

| Screen | Before | After |
|---|---|---|
| Home | ![](screens/before/home-phone-light.webp) | ![](screens/after/home-phone-light.webp) |
| All assets | ![](screens/before/assets-phone-light.webp) | ![](screens/after/assets-phone-light.webp) |
| Asset (ETH on Base) | ![](screens/before/asset-eth-phone-light.webp) | ![](screens/after/asset-eth-phone-light.webp) |
| Receive | ![](screens/before/receive-phone-light.webp) | ![](screens/after/receive-phone-light.webp) |
| Send | ![](screens/before/send-phone-light.webp) | ![](screens/after/send-phone-light.webp) |
| Send — review | ![](screens/before/send-review-phone-light.webp) | ![](screens/after/send-review-phone-light.webp) |
| Activity | ![](screens/before/activity-phone-light.webp) | ![](screens/after/activity-phone-light.webp) |
| Swap with quotes | ![](screens/before/swap-quote-phone-light.webp) | ![](screens/after/swap-quote-phone-light.webp) |
| Agents | ![](screens/before/agents-phone-light.webp) | ![](screens/after/agents-phone-light.webp) |
| Futures terminal | ![](screens/before/futures-phone-light.webp) | ![](screens/after/futures-phone-light.webp) |
| Settings | ![](screens/before/settings-phone-light.webp) | ![](screens/after/settings-phone-light.webp) |
| Lock screen | ![](screens/before/gate-phone-light.webp) | ![](screens/after/gate-phone-light.webp) |

## Phone, dark

| Screen | Before | After |
|---|---|---|
| Home | ![](screens/before/home-phone-dark.webp) | ![](screens/after/home-phone-dark.webp) |
| All assets | ![](screens/before/assets-phone-dark.webp) | ![](screens/after/assets-phone-dark.webp) |
| Asset (USDC on Base) | ![](screens/before/asset-usdc-phone-dark.webp) | ![](screens/after/asset-usdc-phone-dark.webp) |
| Receive | ![](screens/before/receive-phone-dark.webp) | ![](screens/after/receive-phone-dark.webp) |
| Send — review | ![](screens/before/send-review-phone-dark.webp) | ![](screens/after/send-review-phone-dark.webp) |
| Security | ![](screens/before/security-phone-dark.webp) | ![](screens/after/security-phone-dark.webp) |
| Futures terminal | ![](screens/before/futures-phone-dark.webp) | ![](screens/after/futures-phone-dark.webp) |

## Desktop

| Screen | Before | After |
|---|---|---|
| Home, light | ![](screens/before/home-desktop-light.webp) | ![](screens/after/home-desktop-light.webp) |
| Home, dark | ![](screens/before/home-desktop-dark.webp) | ![](screens/after/home-desktop-dark.webp) |
| All assets, light | ![](screens/before/assets-desktop-light.webp) | ![](screens/after/assets-desktop-light.webp) |
| Swap with quotes, light | ![](screens/before/swap-quote-desktop-light.webp) | ![](screens/after/swap-quote-desktop-light.webp) |
| Futures terminal, dark | ![](screens/before/futures-desktop-dark.webp) | ![](screens/after/futures-desktop-dark.webp) |
| Futures — compare, light | ![](screens/before/futures-compare-desktop-light.webp) | ![](screens/after/futures-compare-desktop-light.webp) |

## Logos

| Phone, light | Phone, dark |
|---|---|
| ![](logo-wall/wall-phone-light.webp) | ![](logo-wall/wall-phone-dark.webp) |

Desktop sheets: `logo-wall/wall-desktop-light.webp`, `logo-wall/wall-desktop-dark.webp`.
