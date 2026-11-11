# SP Wallet — design system (v9)

One page. The system lives in `apps/web/src/styles.css` (tokens, component layer), `apps/web/src/ui.tsx` (shared
components), `apps/web/src/icons.tsx` (logos) and `apps/web/src/chart.tsx` (charts). Screens compose these; they do not
restyle themselves. The phone (390 × 844) is the reference; the desktop reuses the same pieces in wider grids.

## Principles

1. **Calm, confident, premium.** One hero per screen, generous numerals, quiet chrome. The real logos are the colour
   accents; the brand colour is kept for the primary action.
2. **Honest before handsome.** This app moves real money. A review shows every field in full; nothing is truncated on an
   approval; no figure the owner is about to approve is ever animated; fees, minimums and warnings are never folded away;
   SIMULATION / TESTNET / RÉEL stay unmistakable. Looks never change what is sent to the API.
3. **Depth by layering, not by paint.** Hairlines, soft shadows, translucency (blurred header, tab bar, sheet scrim). The
   only gradient is the balance hero's aurora.
4. **Colour never carries a meaning alone.** Gains and losses keep their sign and arrow, states keep icon + word,
   chart parts keep their name and share in text.
5. **The finger is answered.** Every tappable thing is ≥ 44 pt and has a visible press state.
6. **Motion is short and optional.** Transform and opacity only, ≤ 0.36 s, off under `prefers-reduced-motion`.

## Type scale

System fonts (SF Pro on Apple devices), no web font. Body text uses **tabular figures** so amounts align in lists;
display numerals use **proportional figures** (a hero amount in tabular figures looks loose).

| Role | Size / weight | Where |
|---|---|---|
| Display (`.t-display`) | clamp(40, 12.6vw, 54) / 650, −0.04em | total balance, asset price, amount on the review receipt |
| Title (`.t-title`, every `main h1`) | 30 / 650, −0.028em | page titles (`PageTitle`) |
| Headline | 17 / 600 | card headings (`H`) |
| Body | 15 – 15.5 / 400–600 | rows, buttons |
| Callout / footnote | 13 – 14 | secondary lines, notices, hints |
| Eyebrow (`.t-eyebrow`) | 11.5 / 600, +0.06em, caps | list section labels (day groups, "held / supported") |
| Micro | 11 – 12 | tab labels, chart axis ends |

Inputs are 16 px (no zoom on focus in iOS).

## Spacing, radii, elevation

- Spacing on a 4 pt grid: page gutter 20, card padding 20, row height ≥ 60 (68 for asset rows), section gap 16–20.
- Radii: 12 (thumbs, small tiles) · 16 (buttons, inputs, notices) · 22 (cards) · 28–30 (hero, sheets, QR plate) · full (chips, logos).
- Elevation tokens: `--e1` resting card · `--e2` raised control (centre tab action, QR plate, pull indicator) · `--e3` sheets.
  In dark, elevation is a lighter surface plus a 1 px inner highlight rather than a larger shadow.

## Colour tokens and contrast (WCAG 2.x ratio; computed by `apps/web/scripts/contrast.mjs`)

| Token | Light | on surface / bg / elev | Dark | on surface / bg / elev |
|---|---|---|---|---|
| `--bg` / `--surface` / `--elev` | `#f3f4f7` / `#ffffff` / `#eceef3` | — | `#06080c` / `#0f131b` / `#1a202c` | — |
| `--ink` | `#0a0d14` | 19.4 / 17.7 / 16.7 | `#f4f6fa` | 17.2 / 18.5 / 15.1 |
| `--mute` | `#596273` | 6.1 / 5.6 / 5.3 | `#98a2b6` | 7.2 / 7.8 / 6.4 |
| `--emerald` (gain, ok) | `#087a55` | 5.4 / 4.9 / 4.6 | `#35e7ac` | 11.7 / 12.6 / 10.2 |
| `--blue` (link, info, focus) | `#2257e0` | 6.0 / 5.4 / 5.2 | `#7ea6ff` | 7.8 / 8.4 / 6.8 |
| `--warn` | `#9a5b06` | 5.4 / 4.9 / 4.7 | `#f4b65b` | 10.4 / 11.2 / 9.1 |
| `--danger` (loss, error) | `#c22a40` | 5.7 / 5.2 / 4.9 | `#ff7d88` | 7.6 / 8.2 / 6.6 |
| `--primary` / `--onprimary` | `#0a0d14` / `#ffffff` | 19.4 | `#35e7ac` / `#04130d` | 11.9 |
| `--danger` / `--ondanger` (button) | `#c22a40` / `#ffffff` | 5.7 | `#ff7d88` / `#2a0508` | 7.6 |

Every pair is ≥ 4.5 : 1 (AA for text), including each tone on its own 10 % wash (notices, pills: 4.7 – 9.7).
Hero text (white at 70 %) on the hero base is 9.6. Below AA on purpose: input placeholders (`--mute` at 70 %).
The dark theme is its own set of values (near-black `#06080c`, not a flip); a pure-black OLED variant is not shipped.

**Data-viz series** (allocation bar): five fixed slots + "other", `--s1…--s5`, `--s-other` — blue, orange, aqua, yellow,
magenta, in that order, never cycled. Validated with the dataviz skill's `validate_palette.js` on both surfaces: light —
adjacent CVD ΔE 9.1, normal-vision 19.6, three slots under 3 : 1 against white (relief: every part is named with its share
in text); dark — CVD 8.4, normal 19.3, all ≥ 3 : 1.

## Logos

`AssetIcon` (historical alias `Coin`), `NetworkIcon` (alias `NetDot`), `VenueIcon`, `ProviderIcon` — real logos only,
self-hosted, sanitised; provenance in `apps/web/src/logos/SOURCES.md`. Every logo sits on a round plate with a hairline
edge: full-bleed discs cover it; a free-form mark keeps the plate (its brand's own background where it has one), so it
never vanishes on a light or dark surface and is never recoloured. A network badge (bottom-right, ring in the surface
colour) is shown whenever the asset is not on its home network, and always for a representation without its own mark
(USDC.e, BTC.b, BTCB, WBNB…). An unknown symbol keeps a neutral letter disc — no logo is invented.

## Motion

| What | How |
|---|---|
| Press | `.press`: scale 0.97, 140 ms; rows tint (`.row-press`) |
| Screen enter | `.rise`: 8 px, 280 ms |
| Sheet | scrim fade 200 ms, panel spring 360 ms, grabber, drag down to dismiss (`Sheet`; never on approval sheets) |
| Balance | `AnimatedNumber`: 520 ms glide, read-only figures only; the final value is exposed to assistive tech at once |
| Hero aurora | two blurred discs drifting 22 s / 26 s (transform only); hue follows the 24 h direction; decorative |
| Skeleton | `.skel` shimmer 1.4 s, shaped like the final layout (`SkeletonRows`) |
| Header | condenses after 6 px of scroll (an attribute toggled in a rAF, no re-render) |
| Pull to refresh | Home and Activity, passive listeners, 64 px threshold, a short vibration where the platform has one |

All of it is disabled by `prefers-reduced-motion: reduce`.

## Component inventory

Surfaces `Card`, `.card`, `.hero`, `.nav-glass` · Structure `PageTitle`, `H`, `.t-eyebrow`, `EmptyState` ·
Actions `Btn` (primary / soft / ghost / danger), `Chips`, `Seg`, `CopyBtn` · Inputs `Field`, `inputCls` ·
Feedback `Notice`, `StatePill`, `Skeleton`, `SkeletonRows`, pull-to-refresh · Data `Money`, `Change`, `AnimatedNumber`,
`Addr`, `Spark`, `PriceChart`, `AllocationBar` · Logos `AssetIcon`, `NetworkIcon`, `VenueIcon`, `ProviderIcon` ·
Overlays `Sheet` and the shared sheet styling applied to every `role="dialog"` of the app.

## Charts (dataviz skill: form first, colour last)

- **Allocation** — one whole split into parts, above a list that already gives each part's name and amount: a thin
  segmented bar (8 px, rounded ends, 2 px gaps, no text on it), not a donut; ≤ 5 parts + "other"; legend with name and
  share in text colour; hover / focus emphasises a part.
- **Price** — one series, one axis, 2 px line, 10 % wash, hairline at the period's open, crosshair that snaps to the
  nearest point with a read-out in ink; min / max and the two dates as the only labels.
- **Sparklines** — decorative trend in the de-emphasis colour with an end marker; the adjacent text carries the value.
