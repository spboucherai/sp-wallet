# funding_carry_neutral_perp / 1

**Hypothesis.** When funding is persistently high, holding the asset and shorting its perpetual for the same
notional earns the funding with almost no exposure to the price: the spot leg gains what the short loses.

**Mechanism.** Same signal as `funding_carry_perp/1` (72-hour mean funding ≥ 15 % per year, ≥ 75 % of the
settlements positive, above its 504-hour average; strength `min(1, z / 2)`). When it is on for an asset: buy
`strength · gross / (2N)` of equity of the asset on the spot market (`X.SPOT`) and short the same weight of the
perpetual `X`. With `gross` = 0.9 and N = 4, at most 45 % of equity is in spot and 45 % is short; the remaining
55 % of USDC is the collateral of the shorts.

**How the spot leg is modelled, and its limits.** The spot leg uses the lab's Coinbase spot candles and spot costs
(10 bps fee + 10 bps slippage); the perpetual uses Hyperliquid candles, funding and costs. In the backtester a spot
leg is paid in full from the account's USDC, is never liquidated and **does not count as margin** for the short —
as when the two legs sit on two venues. What the model leaves out: moving USDC between the venues (it assumes one
pool of cash, so a short that needs margin is fed instantly from cash that would in fact be elsewhere); the basis
between Coinbase's USD price and Hyperliquid's USDT-indexed price, which is in the data but is not hedged; and the
two legs are sized from the same weight but filled at two different prices, so the hedge is equal in notional at
the open, not in units. The neutrality is therefore approximate.

**What would refute it.** Funding collected smaller than the four fills of a round trip (2 × 20 bps spot +
2 × 6.5 bps perp ≈ 53 bps of the hedged notional): at 15 % per year that is about 13 days of carry, so a signal
that lasts less than two weeks loses money by construction. A net exposure that is not close to zero, or a return
that tracks the market, would mean the hedge does not work as modelled.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.
