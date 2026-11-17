// GENERATED data — answers RECORDED on 2026-11-17 from the SDK integration stack (packages/trading-sdk/scripts/test-stack.mts:
// the real API and the real isolated signer on a throwaway database and keystore, paper account of 10 000 simulated USD, a paper
// mandate on hyperliquid:BTC), then trimmed: lists cut to one or two rows, long sentences cut at 180 characters ("…"), the per-asset maps of the signer policy cut to four entries. Nothing
// was invented or edited by hand; the key id was replaced by spk_0123456789ab. A test validates every answer against the zod
// schema of its operation (services/api/test/trading-api-docs.test.ts), so a contract change shows here.
/* eslint-disable */
export const RECORDED: Record<string, unknown> = {
 "listMarkets": {
  "markets": [
   {
    "id": "hyperliquid:BTC",
    "venue": "hyperliquid",
    "kind": "perpetual",
    "symbol": "BTC",
    "base": "BTC",
    "quote": "USD",
    "status": "active",
    "mark": "64432",
    "index": "64460.7",
    "funding": "0.0000089721",
    "fundingIntervalSec": 3600,
    "volume24h": "3621656019.2002997398",
    "openInterest": "37680.57528",
    "maxLeverage": "40",
    "tickSize": "0.1",
    "lotSize": "0.00001",
    "collateral": "USDC",
    "restriction": null,
    "ts": 1794953721101,
    "stale": false,
    "source": "venue"
   }
  ],
  "total": 1,
  "truncated": false,
  "errors": [],
  "ts": 1794953721103
 },
 "compareMarkets": {
  "underlying": "BTC",
  "category": "crypto",
  "request": {
   "underlying": "BTC",
   "side": "long",
   "notionalUsd": "1000",
   "leverage": "2",
   "horizonHours": "24",
   "liquidity": "taker",
   "minNetEdgeBps": "0",
   "depthBps": [
    "10"
   ]
  },
  "rows": [
   {
    "venue": "hyperliquid",
    "venueName": "Hyperliquid",
    "instrument": "hyperliquid:BTC",
    "symbol": "BTC",
    "underlying": "BTC",
    "multiplier": "1",
    "alternatives": [],
    "tradable": true,
    "tradableReason": null,
    "restriction": null,
    "priceOutlier": false,
    "staleAfterMs": 15000,
    "price": {
     "mark": "64432",
     "index": "64460.7",
     "mid": "64432.5"
    },
    "depth": [
     {
      "bps": "10",
      "bidUsd": "6193729.75994",
      "askUsd": "9895537.37818",
      "bidComplete": false,
      "askComplete": false
     }
    ],
    "depthReason": null,
    "fees": {
     "takerRate": "0.00045",
     "makerRate": "0.00015",
     "source": "base tier of the perps fee schedule (taker 0.045 %, maker 0.015 %); 14-day volume tiers and staking discounts lower it — https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fee…",
     "asOf": "2026-11-10"
    },
    "funding": {
     "rate": "0.0000089721",
     "intervalSec": 3600,
     "perHour": "0.0000089721",
     "annualised": "0.0785956",
     "assumption": "the venue's current rate held constant over the horizon; funding rates change every interval"
    },
    "maintenance": {
     "fraction": "0.0125",
     "basis": "1 / (2 × maximum leverage 40): half of the initial margin at the maximum leverage (1 / (2 × max leverage) of notional); tiered by position size — https://hyperliquid.gitbook.io/hyp…"
    },
    "cost": {
     "venue": "hyperliquid",
     "instrument": "hyperliquid:BTC",
     "executionModel": "order_book",
     "midPrice": {
      "value": "64432.5",
      "reason": null,
      "basis": "(best bid + best ask) / 2"
     },
     "spreadBps": {
      "value": "0.1552",
      "reason": null,
      "basis": "(best ask − best bid) / mid"
     },
     "depthBidUsd": {
      "value": "6193729.75994",
      "reason": null,
      "basis": "Σ price × size of the bids within 10 bps of the mid, in the supplied book"
     },
     "depthAskUsd": {
      "value": "9895537.37818",
      "reason": null,
      "basis": "Σ price × size of the asks within 10 bps of the mid, in the supplied book"
     },
     "sizeBase": {
      "value": "0.01552",
      "reason": null,
      "basis": "notional / mid, rounded down to the lot"
     },
     "entryAvgPrice": {
      "value": "64433",
      "reason": null,
      "basis": "average price of walking the book for the whole size"
     },
     "entrySlippageBps": {
      "value": "0.0776",
      "reason": null,
      "basis": "|average entry price − mid| / mid"
     },
     "entrySlippageUsd": {
      "value": "0.00776",
      "reason": null,
      "basis": "entry: average price of walking the book for the whole size vs the mid, half the spread included (router.walkBook)"
     },
     "exitSlippageUsd": {
      "value": "0.00776",
      "reason": null,
      "basis": "exit, on the current book: average price of walking the book for the whole size vs the mid, half the spread included (router.walkBook)"
     },
     "entryFeeUsd": {
      "value": "0.449997",
      "reason": null,
      "basis": "taker rate 0.00045 × notional — base tier of the perps fee schedule (taker 0.045 %, maker 0.015 %); 14-day volume tiers and staking discounts lower it — https://hyperliquid.gitbook…"
     },
     "exitFeeUsd": {
      "value": "0.449997",
      "reason": null,
      "basis": "taker rate 0.00045 × notional — base tier of the perps fee schedule (taker 0.045 %, maker 0.015 %); 14-day volume tiers and staking discounts lower it — https://hyperliquid.gitbook…"
     },
     "fundingUsd": {
      "value": "0.215329",
      "reason": null,
      "basis": "current rate 0.0000089721 per 3600 s (ticker.funding of the venue) held constant for 24 h on the position's notional; longs pay a positive rate"
     },
     "fundingRatePerHour": {
      "value": "0.0000089721",
      "reason": null,
      "basis": "rate per 3600 s × 3600 / 3600"
     },
     "collateralRequiredUsd": {
      "value": "499.9962",
      "reason": null,
      "basis": "notional / leverage, rounded up (margin.initialMargin)"
     },
     "liquidationPrice": {
      "value": "32624.3037974684",
      "reason": null,
      "basis": "isolated, long: equity = maintenance at p; flat maintenance fraction, no fees; no funding accrual; margin = entry notional / leverage; entry at the estimated average entry price"
     },
     "liquidationDistanceBps": {
      "value": "4936.7089",
      "reason": null,
      "basis": "|entry − liquidation price| / entry"
     },
     "maxLeverage": {
      "value": "40",
      "reason": null,
      "basis": "the venue's maximum for the instrument"
     },
     "totalCostUsd": {
      "value": "1.130843",
      "reason": null,
      "basis": "sum of entrySlippageUsd + exitSlippageUsd + entryFeeUsd + exitFeeUsd + fundingUsd"
     },
     "totalCostBps": {
      "value": "11.3085",
      "reason": null,
      "basis": "total cost / position notional"
     },
     "missing": [],
     "assumptions": [
      "the position is opened and closed in full, each in one order"
     ]
    },
    "sourceTs": {
     "ticker": 1794953721101,
     "book": 1794953722689,
     "pool": null
    },
    "ageMs": 1936,
    "stale": false,
    "error": null
   }
  ],
  "discrepancies": [
   {
    "longVenue": "edgex",
    "shortVenue": "hyperliquid",
    "longInstrument": "edgex:BTCUSDC",
    "shortInstrument": "hyperliquid:BTC",
    "grossGapBps": "8.6212",
    "netEdgeEstimateBps": "-10.379",
    "costsUsd": {
     "feesUsd": "1.738914",
     "exitSlippageUsd": "0.01425",
     "fundingUsd": "0.081578"
    },
    "flagged": false,
    "reason": null,
    "actionableFromWallet": false,
    "assumptions": [
     {
      "code": "disc_assume_1",
      "text": "both legs are opened at the same time, in full, at the average prices of walking the two CURRENT books"
     }
    ],
    "risks": [
     {
      "code": "disc_risk_1",
      "text": "execution risk: one leg can fill and the other not, or at a worse price; the books move between the two orders"
     }
    ]
   }
  ],
  "texts": {
   "disclaimer": "Estimates computed from one snapshot of public market data. Not a quote and not a recommendation: the contracts differ between venues (collateral, price used for liquidation, funding rule, execution).",
   "discrepancy": "netEdgeEstimateBps is the price difference between two venues net of fees on four legs, the exit slippage on both and the net funding over the horizon. It is an estimate under the …",
   "assumptions": [
    {
     "code": "cost_1",
     "text": "the position is opened and closed in full, each in one order"
    }
   ]
  },
  "warnings": [],
  "errors": [],
  "locks": [
   {
    "id": "deriv_live_mainnet",
    "on": false
   }
  ],
  "ts": 1794953723037,
  "source": "estimate"
 },
 "getMarket": {
  "market": {
   "id": "hyperliquid:BTC",
   "venue": "hyperliquid",
   "kind": "perpetual",
   "symbol": "BTC",
   "base": "BTC",
   "quote": "USD",
   "status": "active",
   "mark": "64419",
   "ts": 1794953786018,
   "stale": false,
   "source": "venue"
  },
  "instrument": {
   "venue": "hyperliquid",
   "symbol": "BTC",
   "id": "hyperliquid:BTC",
   "base": "BTC",
   "quote": "USD",
   "kind": "perpetual",
   "collateral": "USDC",
   "settlement": "Linear perpetual margined and settled in USDC; the oracle is USDT-denominated for most assets (quanto: USDT PnL paid in USDC, no conversion); funding every hour, peer to peer",
   "tickSize": "0.1",
   "lotSize": "0.00001",
   "minOrderSize": null,
   "minNotional": "10",
   "maxLeverage": "40",
   "marginModes": [
    "cross",
    "isolated"
   ],
   "fundingIntervalSec": 3600,
   "markPriceMethod": "Median of (1) oracle + 150 s EMA of (Hyperliquid mid − oracle), (2) median of best bid, best ask, last trade, (3) weighted median of Binance, OKX, Bybit, Gate IO, MEXC perp mids; u…",
   "status": "active"
  },
  "ticker": {
   "instrument": "hyperliquid:BTC",
   "mark": "64419",
   "index": "64449.4",
   "mid": "64418.5",
   "funding": "0.0000087881",
   "openInterest": "37684.5631",
   "volume24h": "3622010181.9303812981",
   "change24h": "-0.015692",
   "ts": 1794953786018,
   "source": "venue"
  },
  "quality": null,
  "liquidity": null,
  "hasOrderBook": true,
  "errors": {},
  "ts": 1794953786422,
  "source": "venue"
 },
 "getOrderbook": {
  "id": "hyperliquid:BTC",
  "bids": [
   [
    "64432",
    "0.43796"
   ],
   [
    "64431",
    "0.00036"
   ],
   [
    "64426",
    "0.0015"
   ]
  ],
  "asks": [
   [
    "64433",
    "27.19556"
   ],
   [
    "64434",
    "2.14586"
   ],
   [
    "64435",
    "10.15654"
   ]
  ],
  "ts": 1794953722689,
  "stale": false,
  "source": "venue"
 },
 "getCandles": {
  "id": "hyperliquid:BTC",
  "interval": "1h",
  "candles": [
   {
    "ts": 1794945600000,
    "open": "63727",
    "high": "64075",
    "low": "63666",
    "close": "63964",
    "volume": "1914.97454"
   },
   {
    "ts": 1794949200000,
    "open": "63964",
    "high": "64645",
    "low": "63925",
    "close": "64331",
    "volume": "3580.64025"
   }
  ],
  "ts": 1794953723670,
  "stale": false,
  "source": "venue"
 },
 "listPrivateMarkets": {
  "markets": [
   {
    "id": "hyperliquid:io:ANTH",
    "venue": "hyperliquid",
    "platform": "Hyperliquid · EntropyIO (dex io)",
    "operator": "EntropyIO",
    "symbol": "io:ANTH",
    "company": {
     "slug": "anthropic",
     "name": "Anthropic, PBC"
    },
    "status": "live",
    "review": {
     "state": "reviewed",
     "reasons": [],
     "reviewedAt": "2026-11-15",
     "validUntil": "2026-11-18T00:00:00Z",
     "fingerprintChecked": true
    },
    "contract": {
     "nature": "cash-settled perpetual quoted in market cap, pure synthetic, no ownership",
     "unit": {
      "kind": "valuation_usd_billions",
      "label": "USD billions of fully diluted company valuation (1.00 = $1B)"
     },
     "quoteCurrency": "USD",
     "collateral": "USDC",
     "underlying": "Anthropic, PBC",
     "contractSize": "1 contract = 1 unit of ANTH; smallest size 0.001",
     "multiplier": {
      "value": "1",
      "source": "Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)"
     },
     "settlement": "If unlisted at 18 Aug 2028: cash-settled to the 6-month trailing TWAP of the mark. Early-settlement notice: 30-day TWAP. M&A: the confirmed deal market cap, else 30-day TWAP.",
     "ipoConversion": "Stays a market-cap perpetual: \"The oracle switches to Share price × Fully diluted share count ÷ 1,000,000,000 at the first official opening trade.\" The share count is fixed once fr…",
     "oracle": "Blend of an internal price (5-minute-half-life EMA of the book mid, weight up to 0.95 by executable depth) and an undisclosed aggregate of external sources (\"other derivative instr…",
     "liquidation": "Hyperliquid margining of the builder dex: liquidation when account or isolated-position equity falls below the maintenance margin (half of the initial margin at maximum leverage); …",
     "maxLeverage": "15",
     "margin": "cross_allowed",
     "lotSize": "0.001",
     "szDecimals": 3,
     "fundingIntervalSec": 3600,
     "assetId": 200001,
     "dex": "io",
     "oiCapUsd": "275000000",
     "fundingMultiplier": "0.125",
     "onChainDescription": "",
     "unconfirmedConvention": null,
     "sources": [
      "https://docs.entropy.io/market-types/pre-ipo-perpetuals"
     ]
    },
    "market": {
     "price": {
      "value": "1683.9",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — mark price",
      "ts": 1794953724740,
      "stale": false
     },
     "oracle": {
      "value": "1684",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — oracle price",
      "ts": 1794953724740,
      "stale": false
     },
     "mid": {
      "value": "1680.6",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — book mid",
      "ts": 1794953724740,
      "stale": false
     },
     "funding": {
      "value": "-0.0000113686",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — funding rate per interval",
      "ts": 1794953724740,
      "stale": false,
      "intervalSec": 3600
     },
     "openInterest": {
      "value": "117475.832",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — open interest, contracts",
      "ts": 1794953724740,
      "stale": false
     },
     "openInterestUsd": {
      "value": "197817553.5048",
      "source": "wallet arithmetic: open interest × mark × contract multiplier (not a venue field)",
      "ts": 1794953724740,
      "stale": false
     },
     "volume24h": {
      "value": "34445966.2849999964",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — 24 h notional volume, USD",
      "ts": 1794953724740,
      "stale": false
     },
     "volumeBase24h": {
      "value": "20388.063",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — 24 h volume, contracts",
      "ts": 1794953724740,
      "stale": false
     },
     "frozen": false
    },
    "valuation": {
     "syntheticPrice": {
      "value": "1683.9",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — mark price",
      "ts": 1794953724740,
      "stale": false,
      "unit": "valuation_usd_billions",
      "unitLabel": "USD billions of fully diluted company valuation (1.00 = $1B)",
      "priceKind": "mark"
     },
     "contractMarketValue": {
      "value": "1683.9",
      "formula": "contract value = price × 1 (contract size defined by the venue: Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBase…",
      "reason": null,
      "source": "Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)",
      "ts": 1794953724740
     },
     "notionalExposure": {
      "value": "1683.9",
      "formula": "size × contract value, negative for a short",
      "reason": null,
      "position": {
       "side": "long",
       "size": "1"
      },
      "hypothetical": true,
      "ts": 1794953724740
     },
     "impliedValuation": {
      "value": "1683900000000",
      "formula": "implied fully diluted valuation (USD) = price × 1 000 000 000",
      "formulaId": "price_x_1e9",
      "formulaSource": {
       "url": "https://docs.entropy.io/market-types/pre-ipo-perpetuals",
       "quote": "pre-IPO perpetuals are quoted in market cap: a price of $1 represents $1B of the company's fully diluted valuation.",
       "readAt": "2026-11-15"
      },
      "asOf": 1794953724740,
      "label": "market-implied, from the price of a derivative on Hyperliquid · EntropyIO (dex io) — not a company figure",
      "reason": null,
      "reasonCode": null
     },
     "lastPrivateValuation": {
      "value": "965000000000",
      "kind": "primary_round",
      "detail": "Series H, $65B raised, post-money",
      "date": "2026-05-28",
      "sourceUrl": "https://www.anthropic.com/news/series-h",
      "confidence": "high"
     },
     "lastPrivateValuationReason": null,
     "premiumDiscount": {
      "premiumBps": "7449.7409",
      "reason": null,
      "caveat": "the reference is a priced round post money dated 2026-05-28; the contract price is dated 2026-11-17. The two figures are of different kinds and dates"
     },
     "caveats": [
      {
       "code": "synthetic",
       "text": "a synthetic price is the price of a derivative contract: it gives no claim on shares and can trade far from any share transaction"
      }
     ]
    },
    "tradable": false,
    "notTradable": {
     "code": "builder_dex_read_only",
     "reasons": [
      "Builder-deployed (HIP-3) Hyperliquid markets are served for market data only: the wallet's trading path covers the validator-operated dex alone (pinned asset table, signer policy),…"
     ]
    },
    "error": null
   }
  ],
  "companies": [
   {
    "slug": "anthropic",
    "name": "Anthropic, PBC",
    "note": "IPO reported for pricing on 18 Nov 2026 and first trade on 19 Nov 2026 (press; the SEC filing states no date). Every Anthropic contract changes methodology, unit or oracle around that date.",
    "contracts": [
     "hyperliquid:io:ANTH"
    ],
    "lastPrivateValuation": {
     "value": "965000000000",
     "kind": "primary_round",
     "detail": "Series H, $65B raised, post-money",
     "date": "2026-05-28",
     "sourceUrl": "https://www.anthropic.com/news/series-h",
     "confidence": "high"
    },
    "divergence": [
     {
      "unit": "usd_per_share",
      "unitLabel": "USD per 1 share (share class not specified by the operator)",
      "contracts": [
       {
        "id": "hyperliquid:para:ANTH",
        "price": "96.26",
        "ts": 1794953724843
       }
      ],
      "spreadBps": "7.58",
      "note": "spread between the highest and the lowest mark of contracts quoted in the same unit; different contracts with different settlement rules — shown side by side, never averaged"
     }
    ]
   }
  ],
  "excluded": [
   {
    "id": "hyperliquid:xyz:SPCX",
    "company": "SpaceX",
    "reason": "SpaceX is a listed company (Nasdaq: SPCX): the deployer annotates this market as a listed stock and categorises it `stocks`. Not a private market.",
    "liveCategory": "stocks",
    "delisted": false
   }
  ],
  "venues": [
   {
    "venue": "hyperliquid",
    "name": "Hyperliquid (builder-deployed dexes)",
    "status": "ok",
    "error": null,
    "ts": 1794953723863,
    "instruments": 5
   }
  ],
  "venuesWithoutAdapter": [
   {
    "venue": "Aster",
    "note": "ANTHROPICUSDT, OPENAIUSDT, POLYMARKETUSD1, OURAUSD1, MOONSHOTUSD1 — per share against a notional reference count of 1 billion shares"
   }
  ],
  "notice": {
   "tradable": false,
   "code": "private_markets_display_only",
   "text": "Displayed for information only — not tradable from this wallet. These are synthetic derivative contracts: they give no claim on any share. Trading is disabled for two reasons: juri…"
  },
  "filter": {
   "delisted": false
  },
  "position": {
   "side": "long",
   "size": "1"
  },
  "cache": {
   "discovery": {
    "ttl": 60000,
    "maxAge": 900000
   },
   "markets": {
    "ttl": 20000,
    "maxAge": 120000
   },
   "delisted": {
    "ttl": 600000,
    "maxAge": 3600000
   },
   "annotation": {
    "ttl": 600000,
    "maxAge": 3600000
   },
   "book": {
    "ttl": 5000,
    "maxAge": 30000
   },
   "candles": {
    "ttl": 60000,
    "maxAge": 600000
   },
   "edgexTickers": {
    "ttl": 3000,
    "maxAge": 15000
   },
   "edgexInstruments": {
    "ttl": 600000,
    "maxAge": 3600000
   },
   "staleAfter": {
    "hyperliquid": 60000,
    "edgex": 15000
   }
  },
  "reviewedTable": {
   "entries": 10,
   "reviewedAt": "2026-11-15"
  },
  "ts": 1794953725186,
  "source": "venue"
 },
 "getPrivateMarket": {
  "market": {
   "id": "hyperliquid:io:ANTH",
   "venue": "hyperliquid",
   "platform": "Hyperliquid · EntropyIO (dex io)",
   "operator": "EntropyIO",
   "symbol": "io:ANTH",
   "company": {
    "slug": "anthropic",
    "name": "Anthropic, PBC"
   },
   "status": "live",
   "review": {
    "state": "reviewed",
    "reasons": [],
    "reviewedAt": "2026-11-15",
    "validUntil": "2026-11-18T00:00:00Z",
    "fingerprintChecked": true
   },
   "contract": {
    "nature": "cash-settled perpetual quoted in market cap, pure synthetic, no ownership",
    "unit": {
     "kind": "valuation_usd_billions",
     "label": "USD billions of fully diluted company valuation (1.00 = $1B)"
    },
    "quoteCurrency": "USD",
    "collateral": "USDC",
    "underlying": "Anthropic, PBC",
    "contractSize": "1 contract = 1 unit of ANTH; smallest size 0.001",
    "multiplier": {
     "value": "1",
     "source": "Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)"
    },
    "settlement": "If unlisted at 18 Aug 2028: cash-settled to the 6-month trailing TWAP of the mark. Early-settlement notice: 30-day TWAP. M&A: the confirmed deal market cap, else 30-day TWAP.",
    "ipoConversion": "Stays a market-cap perpetual: \"The oracle switches to Share price × Fully diluted share count ÷ 1,000,000,000 at the first official opening trade.\" The share count is fixed once fr…",
    "oracle": "Blend of an internal price (5-minute-half-life EMA of the book mid, weight up to 0.95 by executable depth) and an undisclosed aggregate of external sources (\"other derivative instr…",
    "liquidation": "Hyperliquid margining of the builder dex: liquidation when account or isolated-position equity falls below the maintenance margin (half of the initial margin at maximum leverage); …",
    "maxLeverage": "15",
    "margin": "cross_allowed",
    "lotSize": "0.001",
    "szDecimals": 3,
    "fundingIntervalSec": 3600,
    "assetId": 200001,
    "dex": "io",
    "oiCapUsd": "275000000",
    "fundingMultiplier": "0.125",
    "onChainDescription": "",
    "unconfirmedConvention": null,
    "sources": [
     "https://docs.entropy.io/market-types/pre-ipo-perpetuals"
    ]
   },
   "market": {
    "price": {
     "value": "1683.9",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — mark price",
     "ts": 1794953724740,
     "stale": false
    },
    "oracle": {
     "value": "1684",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — oracle price",
     "ts": 1794953724740,
     "stale": false
    },
    "mid": {
     "value": "1680.6",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — book mid",
     "ts": 1794953724740,
     "stale": false
    },
    "funding": {
     "value": "-0.0000113686",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — funding rate per interval",
     "ts": 1794953724740,
     "stale": false,
     "intervalSec": 3600
    },
    "openInterest": {
     "value": "117475.832",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — open interest, contracts",
     "ts": 1794953724740,
     "stale": false
    },
    "openInterestUsd": {
     "value": "197817553.5048",
     "source": "wallet arithmetic: open interest × mark × contract multiplier (not a venue field)",
     "ts": 1794953724740,
     "stale": false
    },
    "volume24h": {
     "value": "34445966.2849999964",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — 24 h notional volume, USD",
     "ts": 1794953724740,
     "stale": false
    },
    "volumeBase24h": {
     "value": "20388.063",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — 24 h volume, contracts",
     "ts": 1794953724740,
     "stale": false
    },
    "frozen": false
   },
   "valuation": {
    "syntheticPrice": {
     "value": "1683.9",
     "source": "Hyperliquid info metaAndAssetCtxs (dex io) — mark price",
     "ts": 1794953724740,
     "stale": false,
     "unit": "valuation_usd_billions",
     "unitLabel": "USD billions of fully diluted company valuation (1.00 = $1B)",
     "priceKind": "mark"
    },
    "contractMarketValue": {
     "value": "1683.9",
     "formula": "contract value = price × 1 (contract size defined by the venue: Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBase…",
     "reason": null,
     "source": "Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)",
     "ts": 1794953724740
    },
    "notionalExposure": {
     "value": "1683.9",
     "formula": "size × contract value, negative for a short",
     "reason": null,
     "position": {
      "side": "long",
      "size": "1"
     },
     "hypothetical": true,
     "ts": 1794953724740
    },
    "impliedValuation": {
     "value": "1683900000000",
     "formula": "implied fully diluted valuation (USD) = price × 1 000 000 000",
     "formulaId": "price_x_1e9",
     "formulaSource": {
      "url": "https://docs.entropy.io/market-types/pre-ipo-perpetuals",
      "quote": "pre-IPO perpetuals are quoted in market cap: a price of $1 represents $1B of the company's fully diluted valuation.",
      "readAt": "2026-11-15"
     },
     "asOf": 1794953724740,
     "label": "market-implied, from the price of a derivative on Hyperliquid · EntropyIO (dex io) — not a company figure",
     "reason": null,
     "reasonCode": null
    },
    "lastPrivateValuation": {
     "value": "965000000000",
     "kind": "primary_round",
     "detail": "Series H, $65B raised, post-money",
     "date": "2026-05-28",
     "sourceUrl": "https://www.anthropic.com/news/series-h",
     "confidence": "high"
    },
    "lastPrivateValuationReason": null,
    "premiumDiscount": {
     "premiumBps": "7449.7409",
     "reason": null,
     "caveat": "the reference is a priced round post money dated 2026-05-28; the contract price is dated 2026-11-17. The two figures are of different kinds and dates"
    },
    "caveats": [
     {
      "code": "synthetic",
      "text": "a synthetic price is the price of a derivative contract: it gives no claim on shares and can trade far from any share transaction"
     }
    ]
   },
   "tradable": false,
   "notTradable": {
    "code": "builder_dex_read_only",
    "reasons": [
     "Builder-deployed (HIP-3) Hyperliquid markets are served for market data only: the wallet's trading path covers the validator-operated dex alone (pinned asset table, signer policy),…"
    ]
   },
   "error": null
  },
  "book": {
   "bids": [
    [
     "1680.4"
    ],
    [
     "1680.2"
    ],
    [
     "1680.1"
    ]
   ],
   "asks": [
    [
     "1680.8"
    ],
    [
     "1681"
    ],
    [
     "1681.1"
    ]
   ],
   "ts": 1794953724827,
   "stale": false,
   "source": "Hyperliquid info l2Book"
  },
  "candles": {
   "interval": "1d",
   "candles": [
    {
     "ts": 1794700800000,
     "open": "1779.8",
     "high": "1785.7",
     "low": "1752.3",
     "close": "1777.2",
     "volume": "4532.974"
    }
   ],
   "ts": 1794953725389,
   "stale": false,
   "source": "Hyperliquid info candleSnapshot"
  },
  "references": [
   {
    "company": "anthropic",
    "valueUsd": "965000000000",
    "kind": "primary_round",
    "detail": "Series H, $65B raised, post-money",
    "date": "2026-05-28",
    "sourceUrl": "https://www.anthropic.com/news/series-h",
    "confidence": "high",
    "postMoney": true
   }
  ],
  "company": {
   "slug": "anthropic",
   "name": "Anthropic, PBC",
   "note": "IPO reported for pricing on 18 Nov 2026 and first trade on 19 Nov 2026 (press; the SEC filing states no date). Every Anthropic contract changes methodology, unit or oracle around that date.",
   "contracts": [
    "hyperliquid:io:ANTH"
   ],
   "lastPrivateValuation": {
    "value": "965000000000",
    "kind": "primary_round",
    "detail": "Series H, $65B raised, post-money",
    "date": "2026-05-28",
    "sourceUrl": "https://www.anthropic.com/news/series-h",
    "confidence": "high"
   },
   "divergence": [
    {
     "unit": "usd_per_share",
     "unitLabel": "USD per 1 share (share class not specified by the operator)",
     "contracts": [
      {
       "id": "hyperliquid:para:ANTH",
       "price": "96.26",
       "ts": 1794953724843
      }
     ],
     "spreadBps": "7.58",
     "note": "spread between the highest and the lowest mark of contracts quoted in the same unit; different contracts with different settlement rules — shown side by side, never averaged"
    }
   ]
  },
  "sameCompany": [
   {
    "id": "hyperliquid:para:ANTH",
    "platform": "Hyperliquid · Paragon (dex para)",
    "price": {
     "value": "96.26",
     "source": "Hyperliquid info metaAndAssetCtxs (dex para) — mark price",
     "ts": 1794953724843,
     "stale": false
    },
    "unit": {
     "kind": "usd_per_share",
     "label": "USD per 1 share (share class not specified by the operator)"
    },
    "review": "reviewed"
   }
  ],
  "notice": {
   "tradable": false,
   "code": "private_markets_display_only",
   "text": "Displayed for information only — not tradable from this wallet. These are synthetic derivative contracts: they give no claim on any share. Trading is disabled for two reasons: juri…"
  },
  "position": {
   "side": "long",
   "size": "1"
  },
  "ts": 1794953725389,
  "source": "venue"
 },
 "getPrivateMarketCompany": {
  "company": {
   "slug": "anthropic",
   "name": "Anthropic, PBC",
   "note": "IPO reported for pricing on 18 Nov 2026 and first trade on 19 Nov 2026 (press; the SEC filing states no date). Every Anthropic contract changes methodology, unit or oracle around that date."
  },
  "contracts": [
   {
    "id": "hyperliquid:io:ANTH",
    "venue": "hyperliquid",
    "platform": "Hyperliquid · EntropyIO (dex io)",
    "operator": "EntropyIO",
    "symbol": "io:ANTH",
    "company": {
     "slug": "anthropic",
     "name": "Anthropic, PBC"
    },
    "status": "live",
    "review": {
     "state": "reviewed",
     "reasons": [],
     "reviewedAt": "2026-11-15",
     "validUntil": "2026-11-18T00:00:00Z",
     "fingerprintChecked": true
    },
    "contract": {
     "nature": "cash-settled perpetual quoted in market cap, pure synthetic, no ownership",
     "unit": {
      "kind": "valuation_usd_billions",
      "label": "USD billions of fully diluted company valuation (1.00 = $1B)"
     },
     "quoteCurrency": "USD",
     "collateral": "USDC",
     "underlying": "Anthropic, PBC",
     "contractSize": "1 contract = 1 unit of ANTH; smallest size 0.001",
     "multiplier": {
      "value": "1",
      "source": "Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)"
     },
     "settlement": "If unlisted at 18 Aug 2028: cash-settled to the 6-month trailing TWAP of the mark. Early-settlement notice: 30-day TWAP. M&A: the confirmed deal market cap, else 30-day TWAP.",
     "ipoConversion": "Stays a market-cap perpetual: \"The oracle switches to Share price × Fully diluted share count ÷ 1,000,000,000 at the first official opening trade.\" The share count is fixed once fr…",
     "oracle": "Blend of an internal price (5-minute-half-life EMA of the book mid, weight up to 0.95 by executable depth) and an undisclosed aggregate of external sources (\"other derivative instr…",
     "liquidation": "Hyperliquid margining of the builder dex: liquidation when account or isolated-position equity falls below the maintenance margin (half of the initial margin at maximum leverage); …",
     "maxLeverage": "15",
     "margin": "cross_allowed",
     "lotSize": "0.001",
     "szDecimals": 3,
     "fundingIntervalSec": 3600,
     "assetId": 200001,
     "dex": "io",
     "oiCapUsd": "275000000",
     "fundingMultiplier": "0.125",
     "onChainDescription": "",
     "unconfirmedConvention": null,
     "sources": [
      "https://docs.entropy.io/market-types/pre-ipo-perpetuals"
     ]
    },
    "market": {
     "price": {
      "value": "1683.9",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — mark price",
      "ts": 1794953724740,
      "stale": false
     },
     "oracle": {
      "value": "1684",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — oracle price",
      "ts": 1794953724740,
      "stale": false
     },
     "mid": {
      "value": "1680.6",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — book mid",
      "ts": 1794953724740,
      "stale": false
     },
     "funding": {
      "value": "-0.0000113686",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — funding rate per interval",
      "ts": 1794953724740,
      "stale": false,
      "intervalSec": 3600
     },
     "openInterest": {
      "value": "117475.832",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — open interest, contracts",
      "ts": 1794953724740,
      "stale": false
     },
     "openInterestUsd": {
      "value": "197817553.5048",
      "source": "wallet arithmetic: open interest × mark × contract multiplier (not a venue field)",
      "ts": 1794953724740,
      "stale": false
     },
     "volume24h": {
      "value": "34445966.2849999964",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — 24 h notional volume, USD",
      "ts": 1794953724740,
      "stale": false
     },
     "volumeBase24h": {
      "value": "20388.063",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — 24 h volume, contracts",
      "ts": 1794953724740,
      "stale": false
     },
     "frozen": false
    },
    "valuation": {
     "syntheticPrice": {
      "value": "1683.9",
      "source": "Hyperliquid info metaAndAssetCtxs (dex io) — mark price",
      "ts": 1794953724740,
      "stale": false,
      "unit": "valuation_usd_billions",
      "unitLabel": "USD billions of fully diluted company valuation (1.00 = $1B)",
      "priceKind": "mark"
     },
     "contractMarketValue": {
      "value": "1683.9",
      "formula": "contract value = price × 1 (contract size defined by the venue: Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBase…",
      "reason": null,
      "source": "Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)",
      "ts": 1794953724740
     },
     "notionalExposure": {
      "value": "1683.9",
      "formula": "size × contract value, negative for a short",
      "reason": null,
      "position": {
       "side": "long",
       "size": "1"
      },
      "hypothetical": true,
      "ts": 1794953724740
     },
     "impliedValuation": {
      "value": "1683900000000",
      "formula": "implied fully diluted valuation (USD) = price × 1 000 000 000",
      "formulaId": "price_x_1e9",
      "formulaSource": {
       "url": "https://docs.entropy.io/market-types/pre-ipo-perpetuals",
       "quote": "pre-IPO perpetuals are quoted in market cap: a price of $1 represents $1B of the company's fully diluted valuation.",
       "readAt": "2026-11-15"
      },
      "asOf": 1794953724740,
      "label": "market-implied, from the price of a derivative on Hyperliquid · EntropyIO (dex io) — not a company figure",
      "reason": null,
      "reasonCode": null
     },
     "lastPrivateValuation": {
      "value": "965000000000",
      "kind": "primary_round",
      "detail": "Series H, $65B raised, post-money",
      "date": "2026-05-28",
      "sourceUrl": "https://www.anthropic.com/news/series-h",
      "confidence": "high"
     },
     "lastPrivateValuationReason": null,
     "premiumDiscount": {
      "premiumBps": "7449.7409",
      "reason": null,
      "caveat": "the reference is a priced round post money dated 2026-05-28; the contract price is dated 2026-11-17. The two figures are of different kinds and dates"
     },
     "caveats": [
      {
       "code": "synthetic",
       "text": "a synthetic price is the price of a derivative contract: it gives no claim on shares and can trade far from any share transaction"
      }
     ]
    },
    "tradable": false,
    "notTradable": {
     "code": "builder_dex_read_only",
     "reasons": [
      "Builder-deployed (HIP-3) Hyperliquid markets are served for market data only: the wallet's trading path covers the validator-operated dex alone (pinned asset table, signer policy),…"
     ]
    },
    "error": null
   }
  ],
  "delisted": [
   {
    "id": "hyperliquid:vntl:ANTHROPIC",
    "venue": "hyperliquid",
    "platform": "Hyperliquid · Ventuals (dex vntl) — shut down",
    "operator": "Ventuals",
    "symbol": "vntl:ANTHROPIC",
    "company": {
     "slug": "anthropic",
     "name": "Anthropic, PBC"
    },
    "status": "delisted",
    "review": {
     "state": "reviewed",
     "reasons": [],
     "reviewedAt": "2026-11-15",
     "validUntil": null,
     "fingerprintChecked": true
    },
    "contract": {
     "nature": "cash-settled perpetual, pure synthetic — DELISTED: Ventuals shut down on 15 Jun 2026 and its markets were settled",
     "unit": {
      "kind": "valuation_usd_billions",
      "label": "USD billions of company valuation (historical)"
     },
     "quoteCurrency": "USD",
     "collateral": "USDH",
     "underlying": "Anthropic, PBC",
     "contractSize": "1 contract = 1 unit of ANTHROPIC; smallest size 0.001",
     "multiplier": {
      "value": "1",
      "source": "Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)"
     },
     "settlement": "Settled at the 24 h mark TWAP 1618.90 on 15 Jun 2026 (Ventuals sunset guide).",
     "ipoConversion": "not applicable (settled)",
     "oracle": "Was 1/3 Notice price + 2/3 two-hour EMA of the mark (Ventuals documentation).",
     "liquidation": "not applicable (no open position can exist)",
     "maxLeverage": "3",
     "margin": "strict_isolated",
     "lotSize": "0.001",
     "szDecimals": 3,
     "fundingIntervalSec": 3600,
     "assetId": 130002,
     "dex": "vntl",
     "oiCapUsd": "10000000",
     "fundingMultiplier": "0",
     "onChainDescription": "ANTHROPIC tracks the total valuation of Anthropic, in billions. E.g. if 1 ANTHROPIC = $500, then the implied total valuation of the company is $500B.",
     "unconfirmedConvention": null,
     "sources": [
      "https://docs.ventuals.com/perp-specifications/private-companies"
     ]
    },
    "market": {
     "price": {
      "value": "1619.3",
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — mark price (frozen: delisted)",
      "ts": 1794953725593,
      "stale": false
     },
     "oracle": {
      "value": "1618.9",
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — oracle price",
      "ts": 1794953725593,
      "stale": false
     },
     "mid": {
      "value": null,
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — book mid",
      "ts": null,
      "stale": false
     },
     "funding": {
      "value": "0",
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — funding rate per interval",
      "ts": 1794953725593,
      "stale": false,
      "intervalSec": 3600
     },
     "openInterest": {
      "value": "0",
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — open interest, contracts",
      "ts": 1794953725593,
      "stale": false
     },
     "openInterestUsd": {
      "value": "0",
      "source": "wallet arithmetic: open interest × mark × contract multiplier (not a venue field)",
      "ts": 1794953725593,
      "stale": false
     },
     "volume24h": {
      "value": "0",
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — 24 h notional volume, USD",
      "ts": 1794953725593,
      "stale": false
     },
     "volumeBase24h": {
      "value": "0",
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — 24 h volume, contracts",
      "ts": 1794953725593,
      "stale": false
     },
     "frozen": true
    },
    "valuation": {
     "syntheticPrice": {
      "value": "1619.3",
      "source": "Hyperliquid info metaAndAssetCtxs (dex vntl) — mark price (frozen: delisted)",
      "ts": 1794953725593,
      "stale": false,
      "unit": "valuation_usd_billions",
      "unitLabel": "USD billions of company valuation (historical)",
      "priceKind": "frozen mark"
     },
     "contractMarketValue": {
      "value": null,
      "formula": null,
      "reason": "delisted market: the frozen price is not the value of a contract that can be held",
      "source": null,
      "ts": null
     },
     "notionalExposure": {
      "value": null,
      "formula": null,
      "reason": "delisted market: the frozen price is not the value of a contract that can be held",
      "position": {
       "side": "long",
       "size": "1"
      },
      "hypothetical": true,
      "ts": null
     },
     "impliedValuation": {
      "value": null,
      "formula": null,
      "formulaId": null,
      "formulaSource": {
       "url": "https://docs.ventuals.com/perp-specifications/private-companies",
       "quote": "The price of the perp contract is the company valuation divided by 1 billion.",
       "readAt": "2026-11-15"
      },
      "asOf": null,
      "label": null,
      "reason": "delisted market: the price is frozen at its last value of June 2026 and is not a current price — no valuation is derived from it",
      "reasonCode": "delisted_frozen"
     },
     "lastPrivateValuation": {
      "value": "965000000000",
      "kind": "primary_round",
      "detail": "Series H, $65B raised, post-money",
      "date": "2026-05-28",
      "sourceUrl": "https://www.anthropic.com/news/series-h",
      "confidence": "high"
     },
     "lastPrivateValuationReason": null,
     "premiumDiscount": {
      "premiumBps": null,
      "reason": "delisted market: the price is frozen at its last value of June 2026 and is not a current price — no valuation is derived from it",
      "caveat": null
     },
     "caveats": [
      {
       "code": "synthetic",
       "text": "a synthetic price is the price of a derivative contract: it gives no claim on shares and can trade far from any share transaction"
      }
     ]
    },
    "tradable": false,
    "notTradable": {
     "code": "builder_dex_read_only",
     "reasons": [
      "Builder-deployed (HIP-3) Hyperliquid markets are served for market data only: the wallet's trading path covers the validator-operated dex alone (pinned asset table, signer policy),…"
     ]
    },
    "error": null
   }
  ],
  "references": [
   {
    "company": "anthropic",
    "valueUsd": "965000000000",
    "kind": "primary_round",
    "detail": "Series H, $65B raised, post-money",
    "date": "2026-05-28",
    "sourceUrl": "https://www.anthropic.com/news/series-h",
    "confidence": "high",
    "postMoney": true
   }
  ],
  "lastPrivateValuation": {
   "value": "965000000000",
   "kind": "primary_round",
   "detail": "Series H, $65B raised, post-money",
   "date": "2026-05-28",
   "sourceUrl": "https://www.anthropic.com/news/series-h",
   "confidence": "high"
  },
  "divergence": [
   {
    "unit": "usd_per_share",
    "unitLabel": "USD per 1 share (share class not specified by the operator)",
    "contracts": [
     {
      "id": "hyperliquid:para:ANTH",
      "price": "96.26",
      "ts": 1794953724843
     }
    ],
    "spreadBps": "7.58",
    "note": "spread between the highest and the lowest mark of contracts quoted in the same unit; different contracts with different settlement rules — shown side by side, never averaged"
   }
  ],
  "merged": null,
  "mergedReason": "contracts of different venues are different instruments: no average, no blended price, no cross-fill",
  "venues": [
   {
    "venue": "hyperliquid",
    "name": "Hyperliquid (builder-deployed dexes)",
    "status": "ok",
    "error": null,
    "ts": 1794953723863,
    "instruments": 5
   }
  ],
  "notice": {
   "tradable": false,
   "code": "private_markets_display_only",
   "text": "Displayed for information only — not tradable from this wallet. These are synthetic derivative contracts: they give no claim on any share. Trading is disabled for two reasons: juri…"
  },
  "position": {
   "side": "long",
   "size": "1"
  },
  "ts": 1794953725812,
  "source": "venue"
 },
 "getPortfolio": {
  "asOf": "2026-11-17T22:15:27.274Z",
  "wallet": {
   "valueUsd": "0",
   "priced": 0,
   "unpriced": 0,
   "pricesAsOf": "2026-11-17T22:15:27.274Z",
   "balances": [
    {
     "network": "ethereum",
     "networkName": "Ethereum",
     "asset": "native",
     "symbol": "ETH",
     "name": "Ether",
     "decimals": 18,
     "amount": "0",
     "display": "0",
     "error": null,
     "valueUsd": "0",
     "priceSource": "coingecko",
     "priceAt": "2026-11-17T22:14:49.000Z",
     "priceDivergent": false,
     "priceDivergenceBps": null
    }
   ]
  },
  "accounts": [
   {
    "mode": "paper",
    "venue": "hyperliquid",
    "network": "mainnet",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "label": "SDK paper",
    "equity": "10000",
    "collateral": "10000",
    "error": null,
    "source": "paper"
   }
  ],
  "totals": {
   "walletUsd": "0",
   "liveVenueEquity": "0",
   "paperEquity": "10000",
   "note": "three separate figures: the wallet (on-chain, USD), venue accounts on mainnet (live), paper accounts (simulated). They are never added together; testnet accounts are listed but not summed."
  },
  "halted": false,
  "errors": []
 },
 "getBalances": {
  "asOf": "2026-11-17T22:15:28.199Z",
  "balances": [
   {
    "network": "base",
    "networkName": "Base",
    "asset": "native",
    "symbol": "ETH",
    "name": "Ether",
    "decimals": 18,
    "amount": "0",
    "display": "0",
    "error": null
   },
   {
    "network": "base",
    "networkName": "Base",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "symbol": "USDC",
    "name": "USD Coin",
    "decimals": 6,
    "amount": "0",
    "display": "0",
    "error": null
   }
  ],
  "errors": [],
  "halted": false
 },
 "getActivity": {
  "items": [
   {
    "kind": "fill",
    "mode": "paper",
    "at": "2026-11-17T22:15:31.480Z",
    "id": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:paper-f-6",
    "venue": "hyperliquid",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "instrument": "hyperliquid:BTC",
    "side": "sell",
    "price": "64426",
    "size": "0.00078",
    "fee": "0.022613526",
    "closedPnl": "-0.00468"
   },
   {
    "kind": "fill",
    "mode": "paper",
    "at": "2026-11-17T22:15:31.456Z",
    "id": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:paper-f-4",
    "venue": "hyperliquid",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "instrument": "hyperliquid:BTC",
    "side": "sell",
    "price": "64426",
    "size": "0.00077",
    "fee": "0.022323609",
    "closedPnl": "-0.00462"
   }
  ],
  "nextCursor": "WyIxNzk0OTUzNzMxNDU2MDAwIiwiZiIsIjZhMmM4MzUxLWNkNzktNDRlMi1iNzVhLWYzOTI4MGQwZWJjMjpwYXBlci1mLTQiXQ"
 },
 "listNfts": {
  "items": [],
  "total": 0,
  "hiddenSpam": 0,
  "nextCursor": null,
  "valuation": {
   "state": "unavailable",
   "reason": "no_reliable_valuation",
   "note": "an NFT has no value this wallet can establish: it is not counted as zero and not valued at a collection floor; it is not part of GET /portfolio"
  },
  "asOf": "2026-11-17T22:15:28.204Z"
 },
 "getNftMarket": {
  "key": "evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1",
  "network": "ethereum",
  "standard": "erc721",
  "sources": [
   {
    "url": null,
    "listed": {
     "state": "unknown"
    },
    "ask": {
     "state": "unknown"
    },
    "bestOffer": {
     "state": "unknown"
    },
    "lastSale": {
     "state": "unknown"
    },
    "collection": null,
    "collectionFloor": {
     "state": "unknown"
    },
    "verification": null,
    "flags": {
     "suspicious": {
      "state": "unknown"
     },
     "disabled": {
      "state": "unknown"
     },
     "nsfw": {
      "state": "unknown"
     }
    },
    "rarity": {
     "state": "unknown"
    },
    "status": {
     "provider": "opensea",
     "name": "OpenSea",
     "state": "needs_key",
     "code": "no_api_key",
     "unlockedBy": "OPENSEA_API_KEY",
     "stale": false,
     "stamp": null,
     "attribution": null
    }
   }
  ],
  "contradictions": [],
  "rates": {},
  "value": {
   "state": "unavailable",
   "reason": "no_valuation_from_floor_or_single_quote"
  },
  "marketActions": [
   {
    "id": "buy",
    "available": false,
    "reason": "market_writes_not_built"
   },
   {
    "id": "sell",
    "available": false,
    "reason": "market_writes_not_built"
   }
  ],
  "asOf": "2026-11-17T22:15:29.113Z"
 },
 "listPositions": {
  "positions": [
   {
    "id": "paper:hyperliquid:6a2c8351-cd79-44e2-b75a-f39280d0ebc2:hyperliquid:BTC",
    "mode": "paper",
    "venue": "hyperliquid",
    "network": "mainnet",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "instrument": "hyperliquid:BTC",
    "side": "long",
    "size": "0.00155",
    "entryPrice": "64432",
    "markPrice": "64430.7",
    "liquidationPrice": null,
    "leverage": "3",
    "margin": "33.289195",
    "unrealizedPnl": "-0.002015",
    "source": "paper"
   }
  ],
  "errors": [],
  "ts": 1794953731436
 },
 "listOrders": {
  "orders": [
   {
    "id": "0x0276bab16d117c8323ee375b61b01d1d",
    "orderId": "0x0276bab16d117c8323ee375b61b01d1d",
    "mode": "paper",
    "venue": "hyperliquid",
    "network": "mainnet",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "clientId": "0x0276bab16d117c8323ee375b61b01d1d",
    "clientOrderId": "0x0276bab16d117c8323ee375b61b01d1d",
    "venueOrderId": "paper-o-11",
    "instrument": "hyperliquid:BTC",
    "side": "buy",
    "type": "limit",
    "size": "0.001",
    "price": "63775",
    "triggerPrice": null,
    "reduceOnly": false,
    "tif": "gtc",
    "status": "SUBMITTED",
    "final": false,
    "reasonCode": "VENUE_ACCEPTED",
    "reason": null,
    "rejectCode": null,
    "engineStatus": "open",
    "filled": "0",
    "avgFillPrice": null,
    "acknowledged": true,
    "cancelRequested": false,
    "origin": "trading_api",
    "principal": {
     "kind": "api_key",
     "id": "spk_0123456789ab"
    },
    "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
    "engine": "paper",
    "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0x0276bab16d117c8323ee375b61b01d1d",
    "hash": "b4864b795d2a07f377c362c714fbafefd82cf6ce9ec67c88fffb0ccd157a62ff",
    "notionalUsd": "63.775",
    "projectionError": null,
    "version": 4,
    "createdAt": 1794953786427,
    "updatedAt": 1794953786445
   }
  ],
  "nextCursor": null,
  "ts": 1794953786452
 },
 "getOrder": {
  "order": {
   "id": "0xff18683e8e2aa319d3812cf8a47fc261",
   "orderId": "0xff18683e8e2aa319d3812cf8a47fc261",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0xff18683e8e2aa319d3812cf8a47fc261",
   "clientOrderId": "0xff18683e8e2aa319d3812cf8a47fc261",
   "venueOrderId": "paper-o-1",
   "instrument": "hyperliquid:BTC",
   "side": "buy",
   "type": "market",
   "size": "0.00155",
   "price": "64754",
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "ioc",
   "status": "FILLED",
   "final": true,
   "reasonCode": "VENUE_FILLED",
   "reason": null,
   "rejectCode": null,
   "engineStatus": "filled",
   "filled": "0.00155",
   "avgFillPrice": "64432",
   "acknowledged": true,
   "cancelRequested": false,
   "origin": "trading_api",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0xff18683e8e2aa319d3812cf8a47fc261",
   "hash": "1d3481aaee13d8c193c215ba06f786da1cc978c805d9d2f57a102564ddf5c386",
   "notionalUsd": "100.3687",
   "projectionError": null,
   "version": 4,
   "createdAt": 1794953729578,
   "updatedAt": 1794953729602,
   "canonical": {
    "v": 1,
    "tif": "ioc",
    "mode": "paper",
    "side": "buy",
    "size": "0.00155",
    "type": "market",
    "venue": "hyperliquid",
    "network": "mainnet",
    "leverage": null,
    "notional": null,
    "createdAt": 1794953729578,
    "expiresAt": 1794953849578,
    "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
    "maxFeeUsd": "0.099869",
    "principal": {
     "id": "spk_0123456789ab",
     "kind": "api_key"
    },
    "instrument": "hyperliquid:BTC",
    "limitPrice": null,
    "marginMode": null,
    "marketKind": "perp",
    "reduceOnly": false,
    "triggerPrice": null,
    "clientOrderId": "0xff18683e8e2aa319d3812cf8a47fc261",
    "maxSlippageBps": 50
   }
  },
  "fills": [
   {
    "id": "paper-f-2",
    "instrument": "hyperliquid:BTC",
    "side": "buy",
    "price": "64432",
    "size": "0.00155",
    "fee": "0.04494132",
    "feeAsset": "USDC",
    "closedPnl": null,
    "liquidation": false,
    "ts": 1794953729595
   }
  ],
  "history": [
   {
    "seq": 1,
    "from": "CREATED",
    "to": "VALIDATED",
    "event": "validated",
    "reason": "VALIDATION_PASSED",
    "detail": null,
    "at": 1794953729590
   },
   {
    "seq": 2,
    "from": "VALIDATED",
    "to": "APPROVED",
    "event": "approved",
    "reason": "APPROVED_BY_MANDATE",
    "detail": null,
    "at": 1794953729593
   }
  ]
 },
 "previewOrder": {
  "order": {
   "v": 1,
   "venue": "hyperliquid",
   "network": "mainnet",
   "instrument": "hyperliquid:BTC",
   "marketKind": "perp",
   "side": "buy",
   "type": "market",
   "size": "0.00155",
   "notional": null,
   "limitPrice": null,
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "ioc",
   "maxSlippageBps": 50,
   "maxFeeUsd": "0.099869",
   "leverage": null,
   "marginMode": null,
   "clientOrderId": "0xc7f8200619c1018d8757a6318aab7a51",
   "mode": "paper",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "createdAt": 1794953729364,
   "expiresAt": 1794953849364
  },
  "hash": "a780accd8e5abce90b3975329e8386b8117bbd470727ae3b442bbaf852163506",
  "resolved": {
   "size": "0.00155",
   "worstPrice": "64754",
   "notionalUsd": "100.3687"
  },
  "wouldExecute": true,
  "refusals": [],
  "approval": {
   "required": false,
   "by": "mandate",
   "note": "paper: nothing is signed"
  },
  "risk": {
   "decision": "allow",
   "reducing": false,
   "checks": [
    {
     "id": "input_valid",
     "ok": true,
     "observed": null,
     "limit": null,
     "detail": "request, context and limits are well formed",
     "exempt": false
    },
    {
     "id": "read_only",
     "ok": true,
     "observed": "false",
     "limit": "false",
     "detail": "not in read-only mode",
     "exempt": false
    }
   ],
   "derived": {
    "size": "0.00155",
    "notional": "99.91207",
    "referencePrice": "64459.4",
    "positionBefore": "0",
    "positionAfter": "0.00155"
   },
   "decisionId": 1
  },
  "mandate": {
   "id": "84f954ea-0c25-4985-bc19-901d510964d7",
   "decision": "allow",
   "reasons": [],
   "phase": "active"
  },
  "engine": {
   "name": "paper",
   "risk": {
    "ok": true
   },
   "estimate": {
    "leverage": "3",
    "price": "64754",
    "source": "estimate",
    "notional": "99.8696",
    "initialMargin": "33.289866666666666667",
    "fee": "0.04494132",
    "avgFillPrice": "64432",
    "slippageBps": "-0.0776",
    "liquidationPrice": {
     "value": null,
     "source": "estimate",
     "method": "cross, single-position approximation at a flat maintenance fraction of 0.02; position after the immediate fills; no funding, no fees"
    },
    "freeCollateralAfter": "9966.66415868",
    "filledSize": "0.00155",
    "restingSize": "0",
    "status": "filled",
    "rejectReason": null
   }
  },
  "account": {
   "id": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "venue": "hyperliquid",
   "network": "mainnet",
   "equity": "10000",
   "freeCollateral": "10000",
   "withheld": false
  },
  "ts": 1794953729364
 },
 "previewOrderRefused": {
  "order": {
   "v": 1,
   "venue": "hyperliquid",
   "network": "mainnet",
   "instrument": "hyperliquid:BTC",
   "marketKind": "perp",
   "side": "buy",
   "type": "market",
   "size": "0.01396",
   "notional": null,
   "limitPrice": null,
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "ioc",
   "maxSlippageBps": 50,
   "maxFeeUsd": "0.899453",
   "leverage": null,
   "marginMode": null,
   "clientOrderId": "0x39e3aac648c3543c294336a64b5ecdc7",
   "mode": "paper",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "createdAt": 1794953732675,
   "expiresAt": 1794953852675
  },
  "hash": "e520a04b3b86d9a08d062db01b1f31b5836d5e80b26bb6423899e8e0d5c88d1e",
  "resolved": {
   "size": "0.01396",
   "worstPrice": "64738",
   "notionalUsd": "903.74248"
  },
  "wouldExecute": false,
  "refusals": [
   {
    "stage": "mandate",
    "code": "mandate_denied",
    "message": "the order is outside the mandate: ORDER_NOTIONAL_EXCEEDED",
    "reasons": [
     "ORDER_NOTIONAL_EXCEEDED"
    ]
   }
  ],
  "approval": {
   "required": false,
   "by": "mandate",
   "note": "paper: nothing is signed"
  },
  "risk": {
   "decision": "allow",
   "reducing": false,
   "checks": [
    {
     "id": "input_valid",
     "ok": true,
     "observed": null,
     "limit": null,
     "detail": "request, context and limits are well formed",
     "exempt": false
    },
    {
     "id": "read_only",
     "ok": true,
     "observed": "false",
     "limit": "false",
     "detail": "not in read-only mode",
     "exempt": false
    }
   ],
   "derived": {
    "size": "0.01396",
    "notional": "899.853224",
    "referencePrice": "64459.4",
    "positionBefore": "0",
    "positionAfter": "0.01396"
   },
   "decisionId": 16
  },
  "mandate": {
   "id": "84f954ea-0c25-4985-bc19-901d510964d7",
   "decision": "deny",
   "reasons": [
    "ORDER_NOTIONAL_EXCEEDED"
   ],
   "phase": "active"
  },
  "engine": {
   "name": "paper",
   "risk": {
    "ok": true
   },
   "estimate": {
    "leverage": "3",
    "price": "64738",
    "source": "estimate",
    "notional": "899.24736",
    "initialMargin": "299.74912",
    "fee": "0.404661312",
    "avgFillPrice": "64416",
    "slippageBps": "-0.6985",
    "liquidationPrice": {
     "value": null,
     "source": "estimate",
     "method": "cross, single-position approximation at a flat maintenance fraction of 0.02; position after the immediate fills; no funding, no fees"
    },
    "freeCollateralAfter": "9699.883848233",
    "filledSize": "0.01396",
    "restingSize": "0",
    "status": "filled",
    "rejectReason": null
   }
  },
  "account": {
   "id": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "venue": "hyperliquid",
   "network": "mainnet",
   "equity": "9999.900821545",
   "freeCollateral": "9999.900821545",
   "withheld": false
  },
  "ts": 1794953732675
 },
 "placeOrder": {
  "order": {
   "id": "0xff18683e8e2aa319d3812cf8a47fc261",
   "orderId": "0xff18683e8e2aa319d3812cf8a47fc261",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0xff18683e8e2aa319d3812cf8a47fc261",
   "clientOrderId": "0xff18683e8e2aa319d3812cf8a47fc261",
   "venueOrderId": "paper-o-1",
   "instrument": "hyperliquid:BTC",
   "side": "buy",
   "type": "market",
   "size": "0.00155",
   "price": "64754",
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "ioc",
   "status": "FILLED",
   "final": true,
   "reasonCode": "VENUE_FILLED",
   "reason": null,
   "rejectCode": null,
   "engineStatus": "filled",
   "filled": "0.00155",
   "avgFillPrice": "64432",
   "acknowledged": true,
   "cancelRequested": false,
   "origin": "trading_api",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0xff18683e8e2aa319d3812cf8a47fc261",
   "hash": "1d3481aaee13d8c193c215ba06f786da1cc978c805d9d2f57a102564ddf5c386",
   "notionalUsd": "100.3687",
   "projectionError": null,
   "version": 4,
   "createdAt": 1794953729578,
   "updatedAt": 1794953729602
  },
  "idempotent": false,
  "approval": null
 },
 "placeLimitOrder": {
  "order": {
   "id": "0x0276bab16d117c8323ee375b61b01d1d",
   "orderId": "0x0276bab16d117c8323ee375b61b01d1d",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0x0276bab16d117c8323ee375b61b01d1d",
   "clientOrderId": "0x0276bab16d117c8323ee375b61b01d1d",
   "venueOrderId": "paper-o-11",
   "instrument": "hyperliquid:BTC",
   "side": "buy",
   "type": "limit",
   "size": "0.001",
   "price": "63775",
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "gtc",
   "status": "SUBMITTED",
   "final": false,
   "reasonCode": "VENUE_ACCEPTED",
   "reason": null,
   "rejectCode": null,
   "engineStatus": "open",
   "filled": "0",
   "avgFillPrice": null,
   "acknowledged": true,
   "cancelRequested": false,
   "origin": "trading_api",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0x0276bab16d117c8323ee375b61b01d1d",
   "hash": "b4864b795d2a07f377c362c714fbafefd82cf6ce9ec67c88fffb0ccd157a62ff",
   "notionalUsd": "63.775",
   "projectionError": null,
   "version": 4,
   "createdAt": 1794953786427,
   "updatedAt": 1794953786445
  },
  "idempotent": false,
  "approval": null
 },
 "cancelOrder": {
  "order": {
   "id": "0x0276bab16d117c8323ee375b61b01d1d",
   "orderId": "0x0276bab16d117c8323ee375b61b01d1d",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0x0276bab16d117c8323ee375b61b01d1d",
   "clientOrderId": "0x0276bab16d117c8323ee375b61b01d1d",
   "venueOrderId": "paper-o-11",
   "instrument": "hyperliquid:BTC",
   "side": "buy",
   "type": "limit",
   "size": "0.001",
   "price": "63775",
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "gtc",
   "status": "CANCELLED",
   "final": true,
   "reasonCode": "CANCELLED_BY_REQUEST",
   "reason": "cancelled by the user",
   "rejectCode": null,
   "engineStatus": "cancelled",
   "filled": "0",
   "avgFillPrice": null,
   "acknowledged": true,
   "cancelRequested": true,
   "origin": "trading_api",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0x0276bab16d117c8323ee375b61b01d1d",
   "hash": "b4864b795d2a07f377c362c714fbafefd82cf6ce9ec67c88fffb0ccd157a62ff",
   "notionalUsd": "63.775",
   "projectionError": null,
   "version": 6,
   "createdAt": 1794953786427,
   "updatedAt": 1794953786459
  },
  "sent": false,
  "changed": true,
  "venue": null
 },
 "cancelOrderAgain": {
  "order": {
   "id": "0x0276bab16d117c8323ee375b61b01d1d",
   "orderId": "0x0276bab16d117c8323ee375b61b01d1d",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0x0276bab16d117c8323ee375b61b01d1d",
   "clientOrderId": "0x0276bab16d117c8323ee375b61b01d1d",
   "venueOrderId": "paper-o-11",
   "instrument": "hyperliquid:BTC",
   "side": "buy",
   "type": "limit",
   "size": "0.001",
   "price": "63775",
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "gtc",
   "status": "CANCELLED",
   "final": true,
   "reasonCode": "CANCELLED_BY_REQUEST",
   "reason": "cancelled by the user",
   "rejectCode": null,
   "engineStatus": "cancelled",
   "filled": "0",
   "avgFillPrice": null,
   "acknowledged": true,
   "cancelRequested": true,
   "origin": "trading_api",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0x0276bab16d117c8323ee375b61b01d1d",
   "hash": "b4864b795d2a07f377c362c714fbafefd82cf6ce9ec67c88fffb0ccd157a62ff",
   "notionalUsd": "63.775",
   "projectionError": null,
   "version": 6,
   "createdAt": 1794953786427,
   "updatedAt": 1794953786459
  },
  "sent": false,
  "changed": false
 },
 "closePosition": {
  "order": {
   "id": "0xfa8f57b697470c1ec4327676f56a9868",
   "orderId": "0xfa8f57b697470c1ec4327676f56a9868",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0xfa8f57b697470c1ec4327676f56a9868",
   "clientOrderId": "0xfa8f57b697470c1ec4327676f56a9868",
   "venueOrderId": "paper-o-5",
   "instrument": "hyperliquid:BTC",
   "side": "sell",
   "type": "market",
   "size": "0.00078",
   "price": "64104",
   "triggerPrice": null,
   "reduceOnly": true,
   "tif": "ioc",
   "status": "FILLED",
   "final": true,
   "reasonCode": "VENUE_FILLED",
   "reason": null,
   "rejectCode": null,
   "engineStatus": "filled",
   "filled": "0.00078",
   "avgFillPrice": "64426",
   "acknowledged": true,
   "cancelRequested": false,
   "origin": "trading_api",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0xfa8f57b697470c1ec4327676f56a9868",
   "hash": "73c1d9ea9e8be9bc4f6be7ed0febf7f3947552ec479c497b256798e8d217f7cd",
   "notionalUsd": "50.00112",
   "projectionError": null,
   "version": 4,
   "createdAt": 1794953731468,
   "updatedAt": 1794953731487
  },
  "idempotent": false,
  "approval": null
 },
 "reducePosition": {
  "order": {
   "id": "0xae8c2f844447aa3dc5604837d7a7d78f",
   "orderId": "0xae8c2f844447aa3dc5604837d7a7d78f",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0xae8c2f844447aa3dc5604837d7a7d78f",
   "clientOrderId": "0xae8c2f844447aa3dc5604837d7a7d78f",
   "venueOrderId": "paper-o-3",
   "instrument": "hyperliquid:BTC",
   "side": "sell",
   "type": "market",
   "size": "0.00077",
   "price": "64104",
   "triggerPrice": null,
   "reduceOnly": true,
   "tif": "ioc",
   "status": "FILLED",
   "final": true,
   "reasonCode": "VENUE_FILLED",
   "reason": null,
   "rejectCode": null,
   "engineStatus": "filled",
   "filled": "0.00077",
   "avgFillPrice": "64426",
   "acknowledged": true,
   "cancelRequested": false,
   "origin": "trading_api",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0xae8c2f844447aa3dc5604837d7a7d78f",
   "hash": "1528b646d4c9541d3faddcf092cccca76aa9710a7956c811adb5a5128c1a25ad",
   "notionalUsd": "49.36008",
   "projectionError": null,
   "version": 4,
   "createdAt": 1794953731442,
   "updatedAt": 1794953731461
  },
  "idempotent": false,
  "approval": null
 },
 "runCommand": {
  "command": "perp_open",
  "mode": "paper",
  "dryRun": true,
  "kind": "order",
  "order": {
   "v": 1,
   "venue": "hyperliquid",
   "network": "mainnet",
   "instrument": "hyperliquid:BTC",
   "marketKind": "perp",
   "side": "buy",
   "type": "market",
   "size": null,
   "notional": "100",
   "limitPrice": null,
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "ioc",
   "maxSlippageBps": 50,
   "maxFeeUsd": "0.1",
   "leverage": "2",
   "marginMode": "cross",
   "clientOrderId": "0x58617397cbaee774b5a74ada6581a070",
   "mode": "paper",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "createdAt": 1794953783632,
   "expiresAt": 1794953843632
  },
  "hash": "5a6980aa9a3668f4618c2186974428ca40b83bc68ce2be2194f5a02732c57db5",
  "attached": [],
  "executed": false
 },
 "runCommandExecuted": {
  "command": "perp_open",
  "mode": "paper",
  "dryRun": false,
  "kind": "order",
  "executed": true,
  "order": {
   "id": "0x6ba0368ff2e63a4b1e222cf718134f68",
   "orderId": "0x6ba0368ff2e63a4b1e222cf718134f68",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "mainnet",
   "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
   "clientId": "0x6ba0368ff2e63a4b1e222cf718134f68",
   "clientOrderId": "0x6ba0368ff2e63a4b1e222cf718134f68",
   "venueOrderId": "paper-o-7",
   "instrument": "hyperliquid:BTC",
   "side": "buy",
   "type": "market",
   "size": "0.00155",
   "price": "64741",
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "ioc",
   "status": "FILLED",
   "final": true,
   "reasonCode": "VENUE_FILLED",
   "reason": null,
   "rejectCode": null,
   "engineStatus": "filled",
   "filled": "0.00155",
   "avgFillPrice": "64419",
   "acknowledged": true,
   "cancelRequested": false,
   "origin": "command",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "engine": "paper",
   "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0x6ba0368ff2e63a4b1e222cf718134f68",
   "hash": "688e6a27101a97d055ebbf1244f0e392d52ac79aefa99b9e5646975760eacb78",
   "notionalUsd": "100",
   "projectionError": null,
   "version": 4,
   "createdAt": 1794953784500,
   "updatedAt": 1794953784709
  },
  "idempotent": false,
  "approval": null,
  "canonical": {
   "v": 1,
   "venue": "hyperliquid",
   "network": "mainnet",
   "instrument": "hyperliquid:BTC",
   "marketKind": "perp",
   "side": "buy",
   "type": "market",
   "size": null,
   "notional": "100",
   "limitPrice": null,
   "triggerPrice": null,
   "reduceOnly": false,
   "tif": "ioc",
   "maxSlippageBps": 50,
   "maxFeeUsd": "0.1",
   "leverage": "2",
   "marginMode": "cross",
   "clientOrderId": "0x6ba0368ff2e63a4b1e222cf718134f68",
   "mode": "paper",
   "principal": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "createdAt": 1794953784500,
   "expiresAt": 1794953844500
  },
  "hash": "688e6a27101a97d055ebbf1244f0e392d52ac79aefa99b9e5646975760eacb78",
  "attached": []
 },
 "runCommandQuery": {
  "command": "show",
  "mode": "paper",
  "dryRun": false,
  "kind": "query",
  "query": "positions",
  "data": {
   "positions": [],
   "errors": [],
   "ts": 1794953733266
  }
 },
 "engageKillSwitch": {
  "killSwitch": {
   "on": true,
   "at": 1794953765956,
   "by": {
    "kind": "api_key",
    "id": "spk_0123456789ab"
   },
   "reason": "documentation example"
  },
  "readOnly": {
   "on": false,
   "at": null,
   "by": null,
   "reason": null
  }
 },
 "getRisk": {
  "killSwitch": {
   "signerReachable": true,
   "signerHalted": false,
   "note": "the signer halt stops signing (reduce-only exits and cancels are still signed since V11) and is lifted on the signer machine only. The global kill switch of the risk engine (`engin…"
  },
  "signerPolicy": {
   "perTx": {
    "ethereum:ETH": "25000000000000000",
    "ethereum:USDC": "50000000",
    "ethereum:USDT": "50000000",
    "ethereum:PYUSD": "50000000"
   },
   "daily": {
    "ethereum:ETH": "50000000000000000",
    "ethereum:USDC": "100000000",
    "ethereum:USDT": "100000000",
    "ethereum:PYUSD": "100000000"
   },
   "maxFee": {
    "ethereum": "5000000000000000",
    "base": "300000000000000",
    "arbitrum": "300000000000000",
    "optimism": "300000000000000"
   },
   "spentToday": {}
  },
  "capabilityLocks": [
   {
    "id": "deriv_live_mainnet",
    "on": false,
    "why": "SPW_DERIV_LIVE_MAINNET is not \"on\": NEW mainnet risk answers mainnet_disabled (orders that open or add, leverage changes, authorizations, collateral moves); cancels and reduce-only…"
   }
  ],
  "accounts": [
   {
    "mode": "paper",
    "venue": "hyperliquid",
    "network": "mainnet",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "policy": {
     "mode": "PAPER",
     "allowedInstruments": [
      "hyperliquid:BTC"
     ],
     "halt": null,
     "maxDataAgeMs": 10000,
     "maxDeviationBps": "200",
     "maxMarkIndexBps": "100",
     "maxLeverage": "3",
     "maxOrderNotional": "10000",
     "maxGrossExposure": "30000",
     "maxPositionNotional": "20000",
     "minFreeCollateral": "1000",
     "minLiquidationDistanceBps": "1000",
     "maxDailyLoss": "500",
     "maxTotalLoss": "2000",
     "maxOrdersPerMinute": 60,
     "maxOrdersPerDay": 200
    },
    "halted": null,
    "halt": null
   }
  ],
  "key": {
   "limits": {
    "maxOrderNotionalUsd": null,
    "maxDailyNotionalUsd": null
   },
   "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
   "limitsEnforced": true,
   "note": "the key's notional limits and its venue / instrument / network restrictions are applied to every order it places, before the mandate and the risk engine"
  },
  "errors": [],
  "ts": 1794953728201,
  "engine": {
   "killSwitch": {
    "on": false,
    "at": null,
    "by": null,
    "reason": null
   },
   "readOnly": {
    "on": false,
    "at": null,
    "by": null,
    "reason": null
   },
   "note": "the global kill switch blocks every new risk (cancels and strictly reducing orders pass); read-only mode lets only cancels pass. Releasing either needs the owner's passkey."
  }
 },
 "listStrategies": {
  "library": [
   {
    "kind": "perp",
    "path": "strategies/basis_cash_carry/1",
    "sha256": "344831f2ea276d1b3935164287a3e81e5dcc2940841622a88fb3ca218a0a790b",
    "meta": {
     "name": "basis_cash_carry",
     "version": "1",
     "kind": "perp",
     "universe": [
      "BTC"
     ],
     "interval": "1h",
     "lookback": 720,
     "max_leverage": 1,
     "max_gross_exposure": 1,
     "params": {
      "window": 168,
      "enter_net_apr": 0.05,
      "exit_apr": 0.02,
      "round_trip_cost_bps": 60,
      "holding_days": 30,
      "max_adverse_basis_bps": 15,
      "state_bars": 336,
      "gross": 0.9
     }
    }
   }
  ],
  "versions": [
   {
    "id": "450bc266-e1a9-4807-9113-7da6773ddb4e",
    "agentId": "fa9c1fd9-a005-4825-bd67-ea180a2eb83d",
    "kind": "perp",
    "name": "momentum_xs_perp",
    "version": "2",
    "sha256": "75cd4dfae65f6d55667bfaf3fe2eee2b5c98c18edbe8b43dcd8480d88262e272",
    "status": "backtesting",
    "hasReport": false,
    "createdAt": 1794953786690,
    "approvedAt": null
   }
  ],
  "errors": []
 },
 "listAgents": {
  "agents": [
   {
    "id": "b9180e9d-3977-403c-a072-9af105bfd59b",
    "name": "Docs funding",
    "mission": "",
    "kind": "stream",
    "family": "funding_arb",
    "template": "funding-arb",
    "engine": "stream",
    "state": "CREATED",
    "phase": "CREATED",
    "mode": "RESEARCH",
    "venue": "hyperliquid+dydx",
    "network": "hyperliquid+dydx",
    "universe": [
     "BTC"
    ],
    "interval": "stream",
    "capitalUsd": "1000",
    "riskLimits": {
     "maxGrossUsd": 1000,
     "maxDataAgeMs": 5000,
     "maxPositionUsd": 500,
     "maxDailyLossPct": 2,
     "maxTotalLossPct": 5
    },
    "configVersion": 1,
    "strategy": {
     "name": "funding_differential",
     "version": "1",
     "sha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
     "path": null,
     "status": "built_in",
     "kind": "rule"
    },
    "mandate": null,
    "pausedFrom": null,
    "live": {
     "capable": false,
     "code": "family_not_live",
     "reason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
    },
    "stopReason": null,
    "lastBar": null,
    "createdAt": 1794953757211,
    "updatedAt": 1794953757211,
    "lifecycle": "stopped",
    "tradingMode": "research",
    "strategyVersionId": null,
    "mandateId": null,
    "accountId": null
   }
  ]
 },
 "listAgentTemplates": {
  "templates": [
   {
    "id": "stat-arb",
    "family": "stat_arb",
    "engine": "bar",
    "kind": "perp",
    "name": {
     "fr": "Arbitrage statistique",
     "en": "Statistical Arbitrage"
    },
    "summary": {
     "fr": "Paire ou panier co-intégré de contrats perpétuels Hyperliquid : achète l'écart quand il s'éloigne de sa moyenne, le revend quand il y revient.",
     "en": "A co-integrated pair or basket of Hyperliquid perpetuals: buys the spread when it is far from its mean, sells it back when it returns."
    },
    "modes": [
     "research"
    ],
    "liveReason": null,
    "strategyNames": [
     "statarb_basket_perp"
    ],
    "installed": [
     {
      "path": "statarb_basket_perp/1",
      "name": "statarb_basket_perp",
      "version": "1",
      "sha256": "2cca1c2fac270ccb078f39699637ce600292459b29fe591427ef4d33aa7438e1",
      "universe": [
       "BTC"
      ],
      "interval": "1h",
      "spotLegs": false,
      "generic": false,
      "minSymbols": 6,
      "maxSymbols": 6,
      "defaultUniverse": null,
      "liveCapable": false,
      "liveReason": "its universe includes LINK, AAVE, HYPE, outside the signer's pinned instruments (BTC, ETH, SOL); an agent runs a fixed-universe strategy only on its exact universe, so it stays on paper",
      "liveCondition": null
     }
    ],
    "strategyInstalled": true,
    "rule": null,
    "labBacktest": {
     "wanted": [],
     "installed": [],
     "agentRunnable": false
    },
    "labStudies": [],
    "labVerdicts": [
     {
      "available": true,
      "kind": "strategy",
      "backtest": true,
      "name": "statarb_basket_perp",
      "version": "1",
      "strategy": "statarb_basket_perp/1",
      "sha256": "2cca1c2fac270ccb078f39699637ce600292459b29fe591427ef4d33aa7438e1",
      "symbols": [
       "BTC"
      ],
      "where": "strategies",
      "installedHashMatches": true,
      "scope": "agent",
      "liveCapable": false,
      "deflatedSharpe": 0.000002855202061682034,
      "deflatedSharpeThreshold": 0.95,
      "significant": false,
      "trialsTested": 31,
      "ownTrials": 5,
      "testSharpeCi": [
       -18.476770725759938
      ],
      "splits": {
       "train": {
        "netReturn": -0.10170708254821714,
        "netSharpe": -7.182497476407538,
        "grossSharpe": -2.942848775728168,
        "maxDrawdown": 0.10170708254821714,
        "trades": 384,
        "stop": {
         "code": "total_loss",
         "reason": "total loss limit reached (10 % of the capital)",
         "ts": "2026-06-29T18:00:00+00:00"
        },
        "grossToNet": {
         "pricePnl": -42.47637,
         "funding": 0.286722681079791,
         "fees": 17.985133225783834,
         "liquidationPenalties": 0,
         "slippage": 4.3453824145459,
         "latency": 37.186919588967264,
         "netPnl": -101.70708254821716
        }
       },
       "validation": {
        "netReturn": -0.10328278271158842,
        "netSharpe": -10.506726964730408,
        "grossSharpe": 0.2656999138474378,
        "maxDrawdown": 0.10328278271158842,
        "trades": 870,
        "stop": {
         "code": "total_loss",
         "reason": "total loss limit reached (10 % of the capital)",
         "ts": "2026-09-25T08:00:00+00:00"
        },
        "grossToNet": {
         "pricePnl": 2.05459,
         "funding": 0.294203640074876,
         "fees": 34.364870451549976,
         "liquidationPenalties": 0,
         "slippage": 8.0428194421408,
         "latency": 63.22388645797256,
         "netPnl": -103.28278271158842
        }
       },
       "test": {
        "netReturn": -0.10165090743737748,
        "netSharpe": -11.067904972523419,
        "grossSharpe": 0.7338473369539557,
        "maxDrawdown": 0.1024842740501597,
        "trades": 851,
        "stop": {
         "code": "total_loss",
         "reason": "total loss limit reached (10 % of the capital)",
         "ts": "2026-11-04T16:00:00+00:00"
        },
        "grossToNet": {
         "pricePnl": 6.1472,
         "funding": -0.381330817681965,
         "fees": 37.63228249889594,
         "liquidationPenalties": 0,
         "slippage": 8.9354844276773,
         "latency": 60.84900969312219,
         "netPnl": -101.65090743737744
        }
       }
      },
      "stoppedSplits": [
       "train"
      ],
      "checks": {
       "lookahead": "pass",
       "data_quality": "pass",
       "ledger": "pass",
       "funding_alignment": "pass"
      },
      "window": {
       "start": "2026-05-19T00:00:00+00:00",
       "end": "2026-11-14T23:00:00+00:00",
       "interval": "1h",
       "bars": 4320
      },
      "splitDates": {
       "train": [
        "2026-05-19T00:00:00+00:00"
       ],
       "validation": [
        "2026-09-04T00:00:00+00:00"
       ],
       "test": [
        "2026-10-10T00:00:00+00:00"
       ]
      },
      "dataSha256": "060687f0fc9f948d28ce5c5fd39c32798b3c924c35e0a5bb879dceec408c00f5",
      "codeSha256": "6ea1cf4df5ceb8b33c0a763ca1c8724c76de60b861714597b73295ec89507356",
      "engineParityApplied": true,
      "results": {
       "dir": "research/results/2026-11-15-v11",
       "file": "statarb_basket_perp-1.json",
       "fileSha256": "745a629f00d35b8b76d0e0ea681a7dbe22501b74b86351e80fd23ab3ebe71f14",
       "matchesManifest": true
      }
     }
    ],
    "defaults": {
     "universe": [
      "BTC"
     ],
     "venues": [
      "hyperliquid"
     ],
     "interval": "1h",
     "capitalUsdc": "1000",
     "config": {},
     "risk": {
      "maxLeverage": 2,
      "maxGrossExposureX": 1.5,
      "maxPositionX": 1,
      "maxDailyLossPct": 3,
      "maxTotalLossPct": 10,
      "slippageBps": 30,
      "minTradePct": 2
     }
    }
   }
  ]
 },
 "getAgent": {
  "agent": {
   "id": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "name": "Docs funding",
   "mission": "",
   "kind": "stream",
   "family": "funding_arb",
   "template": "funding-arb",
   "engine": "stream",
   "state": "stopped",
   "phase": "CREATED",
   "mode": "research",
   "venue": "hyperliquid+dydx",
   "network": "hyperliquid+dydx",
   "universe": [
    "BTC"
   ],
   "interval": "stream",
   "capitalUsd": "1000",
   "riskLimits": {
    "maxGrossUsd": 1000,
    "maxDataAgeMs": 5000,
    "maxPositionUsd": 500,
    "maxDailyLossPct": 2,
    "maxTotalLossPct": 5
   },
   "configVersion": 1,
   "strategy": {
    "name": "funding_differential",
    "version": "1",
    "sha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
    "path": null,
    "status": "built_in",
    "kind": "rule"
   },
   "mandate": null,
   "pausedFrom": null,
   "live": {
    "capable": false,
    "code": "family_not_live",
    "reason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
   },
   "stopReason": null,
   "lastBar": null,
   "createdAt": 1794953757211,
   "updatedAt": 1794953757211,
   "familyModes": {
    "engine": "stream",
    "modes": [
     "research",
     "paper"
    ],
    "liveReason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
   },
   "backtests": {
    "label": "backtest",
    "note": "A backtest is a simulation on historical data under stated assumptions. It is not a track record and is never shown as performance.",
    "versions": [],
    "recorded": null
   },
   "runtime": {
    "venues": [
     "hyperliquid",
     "dydx"
    ],
    "rule": "funding_differential",
    "config": {
     "notionalUsd": "250",
     "horizonHours": "24",
     "minNetCarryBps": "5",
     "decisionEveryMs": 60000,
     "exitNetCarryBps": "0"
    },
    "counters": null,
    "hold": null,
    "lastPass": null,
    "book": null
   },
   "worker": {
    "lease": null,
    "tick": null
   },
   "jobs": [],
   "killSwitch": {
    "engaged": false,
    "reason": null,
    "at": null,
    "by": null,
    "readOnly": false,
    "readOnlyReason": null,
    "release": {
     "route": "/risk",
     "passkey": true
    }
   }
  },
  "mandateDraft": {
   "draft": "agent:b9180e9d-3977-403c-a072-9af105bfd59b",
   "agentId": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "family": "funding_arb",
   "approval": {
    "route": "/risk?mandate=agent:b9180e9d-3977-403c-a072-9af105bfd59b",
    "note": "the mandate is approved by the owner with the passkey; the signer judges the approval and enforces the mandate on every order"
   },
   "available": false,
   "code": "family_not_live",
   "reason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat",
   "fields": null
  }
 },
 "listAgentSignals": {
  "mode": "paper",
  "signals": [
   {
    "id": "2",
    "ts": 1794953758433,
    "mode": "paper",
    "kind": "stream",
    "configVersion": 1,
    "strategySha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
    "inputsDigest": "ce04a27eb7d4a2a54c55ea9a63340283bc5ffb6cc7ff9aba8f86947ac273a1a4",
    "status": "done",
    "decision": "skipped",
    "reasonCode": "edge_below_threshold",
    "reason": "net carry -17.23 bps over 24 h (gross 1.77, fees 19.00) is below 5 bps",
    "output": {
     "a": {
      "id": "hyperliquid:BTC",
      "rate": "0.0000088903",
      "venue": "hyperliquid",
      "hourlyBps": 0.088903,
      "takerRate": 0.00045,
      "intervalSec": 3600
     },
     "b": {
      "id": "dydx:BTC-USD",
      "rate": "0.00000153333333333333",
      "venue": "dydx",
      "hourlyBps": 0.015333333333,
      "takerRate": 0.0005,
      "intervalSec": 3600
     },
     "legs": [],
     "action": "hold",
     "reason": "net carry -17.23 bps over 24 h (gross 1.77, fees 19.00) is below 5 bps",
     "feesBps": 19,
     "longVenue": "dydx",
     "reasonCode": "edge_below_threshold",
     "shortVenue": "hyperliquid",
     "netCarryBps": -17.234327999992,
     "grossCarryBps": 1.7656720000079997,
     "diffBpsPerHour": 0.07356966666699999
    },
    "scaled": null,
    "scale": null,
    "equity": "1000",
    "targets": null,
    "orders": null,
    "createdAt": 1794953758435,
    "updatedAt": 1794953758435
   },
   {
    "id": "1",
    "ts": 1794953757448,
    "mode": "paper",
    "kind": "stream",
    "configVersion": 1,
    "strategySha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
    "inputsDigest": null,
    "status": "hold",
    "decision": "skipped",
    "reasonCode": "data_gap",
    "reason": "hyperliquid:BTC: the stream is reconnecting",
    "output": null,
    "scaled": null,
    "scale": null,
    "equity": null,
    "targets": null,
    "orders": null,
    "createdAt": 1794953757449,
    "updatedAt": 1794953757449
   }
  ]
 },
 "listAgentJournal": {
  "mode": "paper",
  "entries": [
   {
    "id": "3",
    "ts": 1794953758433,
    "mode": "paper",
    "kind": "state",
    "severity": "info",
    "code": "data_ok",
    "title": "Data is fresh again: decisions resume",
    "body": "after 1 s (data_gap)",
    "data": null,
    "ref": null,
    "configVersion": 1
   },
   {
    "id": "2",
    "ts": 1794953757448,
    "mode": "paper",
    "kind": "hold",
    "severity": "warning",
    "code": "data_gap",
    "title": "Data gap: quoting and decisions paused",
    "body": "hyperliquid:BTC: the stream is reconnecting",
    "data": null,
    "ref": null,
    "configVersion": 1
   }
  ]
 },
 "listAgentOrders": {
  "mode": "paper",
  "orders": []
 },
 "getAgentPerformance": {
  "points": 1,
  "from": 1794953700000,
  "to": 1794953700000,
  "periodsPerYear": null,
  "totalReturn": {
   "value": null,
   "reason": "fewer than two equity points"
  },
  "volatility": {
   "value": null,
   "reason": "fewer than two returns"
  },
  "sharpe": {
   "value": null,
   "reason": "fewer than two returns"
  },
  "sortino": {
   "value": null,
   "reason": "fewer than two returns"
  },
  "maxDrawdown": {
   "value": 0,
   "reason": null
  },
  "winRate": {
   "value": null,
   "reason": "the simulated book keeps positions at average cost: per-trade results are not kept (win rate and profit factor are not computed)"
  },
  "profitFactor": {
   "value": null,
   "reason": "the simulated book keeps positions at average cost: per-trade results are not kept (win rate and profit factor are not computed)"
  },
  "turnover": {
   "value": 0,
   "reason": null
  },
  "feesUsd": {
   "value": 0,
   "reason": null
  },
  "fundingUsd": {
   "value": 0,
   "reason": null
  },
  "slippageUsd": {
   "value": null,
   "reason": "simulated fills are at the quote or at the book price read by the decision"
  },
  "netPnlUsd": {
   "value": null,
   "reason": "fewer than two equity points"
  },
  "closedTrades": 0,
  "orders": 0,
  "warnings": [
   {
    "code": "small_sample",
    "message": "1 equity point(s): volatility, Sharpe and Sortino on fewer than 30 points say almost nothing"
   }
  ],
  "mode": "paper",
  "label": "PAPER — simulated orders and fills; no money moved",
  "equityCurve": [
   {
    "ts": 1794953700000,
    "equity": 1000
   }
  ]
 },
 "getJob": {
  "job": {
   "id": "72526d3e-9b2a-4f86-977b-07b6531868a8",
   "agentId": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "kind": "backtest",
   "status": "done",
   "deadLettered": false,
   "attempts": 1,
   "maxAttempts": 2,
   "runAt": 1794953761249,
   "error": null,
   "result": {
    "kind": "recorded_replay",
    "label": "backtest",
    "missing": 360,
    "warnings": [
     "0 recorded instant(s): far too few to conclude anything",
     "360 of 360 expected snapshots are missing in this window: the replay skipped them"
    ],
    "snapshots": 0
   },
   "createdAt": 1794953761249,
   "updatedAt": 1794953762380,
   "finishedAt": 1794953762380
  }
 },
 "createAgent": {
  "agent": {
   "id": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "name": "Docs funding",
   "mission": "",
   "kind": "stream",
   "family": "funding_arb",
   "template": "funding-arb",
   "engine": "stream",
   "state": "stopped",
   "phase": "CREATED",
   "mode": "research",
   "venue": "hyperliquid+dydx",
   "network": "hyperliquid+dydx",
   "universe": [
    "BTC"
   ],
   "interval": "stream",
   "capitalUsd": "1000",
   "riskLimits": {
    "maxGrossUsd": 1000,
    "maxDataAgeMs": 5000,
    "maxPositionUsd": 500,
    "maxDailyLossPct": 2,
    "maxTotalLossPct": 5
   },
   "configVersion": 1,
   "strategy": {
    "name": "funding_differential",
    "version": "1",
    "sha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
    "path": null,
    "status": "built_in",
    "kind": "rule"
   },
   "mandate": null,
   "pausedFrom": null,
   "live": {
    "capable": false,
    "code": "family_not_live",
    "reason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
   },
   "stopReason": null,
   "lastBar": null,
   "createdAt": 1794953757211,
   "updatedAt": 1794953757211
  },
  "strategy": null,
  "warnings": [
   {
    "code": "no_live",
    "message": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
   }
  ]
 },
 "startAgent": {
  "agent": {
   "id": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "name": "Docs funding",
   "mission": "",
   "kind": "stream",
   "family": "funding_arb",
   "template": "funding-arb",
   "engine": "stream",
   "state": "active",
   "phase": "PAPER_TRADING",
   "mode": "paper",
   "venue": "hyperliquid+dydx",
   "network": "hyperliquid+dydx",
   "universe": [
    "BTC"
   ],
   "interval": "stream",
   "capitalUsd": "1000",
   "riskLimits": {
    "maxGrossUsd": 1000,
    "maxDataAgeMs": 5000,
    "maxPositionUsd": 500,
    "maxDailyLossPct": 2,
    "maxTotalLossPct": 5
   },
   "configVersion": 1,
   "strategy": {
    "name": "funding_differential",
    "version": "1",
    "sha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
    "path": null,
    "status": "built_in",
    "kind": "rule"
   },
   "mandate": null,
   "pausedFrom": null,
   "live": {
    "capable": false,
    "code": "family_not_live",
    "reason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
   },
   "stopReason": null,
   "lastBar": null,
   "createdAt": 1794953757211,
   "updatedAt": 1794953757230
  }
 },
 "pauseAgent": {
  "agent": {
   "id": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "name": "Docs funding",
   "mission": "",
   "kind": "stream",
   "family": "funding_arb",
   "template": "funding-arb",
   "engine": "stream",
   "state": "paused",
   "phase": "PAUSED",
   "mode": "paper",
   "venue": "hyperliquid+dydx",
   "network": "hyperliquid+dydx",
   "universe": [
    "BTC"
   ],
   "interval": "stream",
   "capitalUsd": "1000",
   "riskLimits": {
    "maxGrossUsd": 1000,
    "maxDataAgeMs": 5000,
    "maxPositionUsd": 500,
    "maxDailyLossPct": 2,
    "maxTotalLossPct": 5
   },
   "configVersion": 1,
   "strategy": {
    "name": "funding_differential",
    "version": "1",
    "sha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
    "path": null,
    "status": "built_in",
    "kind": "rule"
   },
   "mandate": null,
   "pausedFrom": "PAPER",
   "live": {
    "capable": false,
    "code": "family_not_live",
    "reason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
   },
   "stopReason": null,
   "lastBar": null,
   "createdAt": 1794953757211,
   "updatedAt": 1794953763760
  }
 },
 "stopAgent": {
  "agent": {
   "id": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "name": "Docs funding",
   "mission": "",
   "kind": "stream",
   "family": "funding_arb",
   "template": "funding-arb",
   "engine": "stream",
   "state": "stopped",
   "phase": "STOPPED",
   "mode": "paper",
   "venue": "hyperliquid+dydx",
   "network": "hyperliquid+dydx",
   "universe": [
    "BTC"
   ],
   "interval": "stream",
   "capitalUsd": "1000",
   "riskLimits": {
    "maxGrossUsd": 1000,
    "maxDataAgeMs": 5000,
    "maxPositionUsd": 500,
    "maxDailyLossPct": 2,
    "maxTotalLossPct": 5
   },
   "configVersion": 1,
   "strategy": {
    "name": "funding_differential",
    "version": "1",
    "sha256": "7c53a77d736f7b71e27fb395c798349a14ed65cd42da6b7b0f6bb35ed078f4e3",
    "path": null,
    "status": "built_in",
    "kind": "rule"
   },
   "mandate": null,
   "pausedFrom": "PAPER",
   "live": {
    "capable": false,
    "code": "family_not_live",
    "reason": "mode réel indisponible : une seule plateforme autorise l'exécution sous mandat"
   },
   "stopReason": "stopped by key:spk_0123456789ab: documentation example",
   "lastBar": null,
   "createdAt": 1794953757211,
   "updatedAt": 1794953763767
  },
  "windDown": null
 },
 "backtestAgent": {
  "job": {
   "id": "72526d3e-9b2a-4f86-977b-07b6531868a8",
   "agentId": "b9180e9d-3977-403c-a072-9af105bfd59b",
   "kind": "backtest",
   "status": "queued",
   "deadLettered": false,
   "attempts": 0,
   "maxAttempts": 2,
   "runAt": 1794953761249,
   "error": null,
   "result": null,
   "createdAt": 1794953761249,
   "updatedAt": 1794953761249,
   "finishedAt": null
  },
  "label": "backtest"
 },
 "createStrategy": {
  "strategy": {
   "id": "450bc266-e1a9-4807-9113-7da6773ddb4e",
   "agentId": "fa9c1fd9-a005-4825-bd67-ea180a2eb83d",
   "sha256": "75cd4dfae65f6d55667bfaf3fe2eee2b5c98c18edbe8b43dcd8480d88262e272",
   "status": "backtesting"
  },
  "note": "registered and queued for its backtest; approval for LIVE stays the owner's"
 },
 "backtestStrategy": {
  "job": {
   "id": "43823b3b-af8c-4c78-8527-638ea5fde77b",
   "agentId": "fa9c1fd9-a005-4825-bd67-ea180a2eb83d",
   "kind": "backtest",
   "status": "queued",
   "deadLettered": false,
   "attempts": 0,
   "maxAttempts": 2,
   "runAt": 1794953786889,
   "error": null,
   "result": null,
   "createdAt": 1794953786889,
   "updatedAt": 1794953786889,
   "finishedAt": null
  },
  "label": "backtest"
 },
 "stopStrategy": {
  "agent": {
   "id": "fa9c1fd9-a005-4825-bd67-ea180a2eb83d",
   "name": "Docs momentum",
   "mission": "",
   "kind": "perp",
   "family": "momentum",
   "template": "momentum",
   "engine": "bar",
   "state": "stopped",
   "phase": "STOPPED",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "hyperliquid",
   "universe": [
    "BTC",
    "ETH"
   ],
   "interval": "1h",
   "capitalUsd": "1000",
   "riskLimits": {
    "maxLeverage": 2,
    "minTradePct": 2,
    "slippageBps": 30,
    "maxPositionX": 1,
    "maxDailyLossPct": 3,
    "maxTotalLossPct": 10,
    "maxGrossExposureX": 1.5
   },
   "configVersion": 2,
   "strategy": null,
   "mandate": null,
   "pausedFrom": null,
   "live": {
    "capable": true,
    "code": null,
    "reason": null
   },
   "stopReason": "stopped by the key:spk_0123456789ab",
   "lastBar": null,
   "createdAt": 1794953786472,
   "updatedAt": 1794953786894
  },
  "windDown": null
 },
 "startStrategy": {
  "agent": {
   "id": "fa9c1fd9-a005-4825-bd67-ea180a2eb83d",
   "name": "Docs momentum",
   "mission": "",
   "kind": "perp",
   "family": "momentum",
   "template": "momentum",
   "engine": "bar",
   "state": "active",
   "phase": "PAPER_TRADING",
   "mode": "paper",
   "venue": "hyperliquid",
   "network": "hyperliquid",
   "universe": [
    "BTC",
    "ETH"
   ],
   "interval": "1h",
   "capitalUsd": "1000",
   "riskLimits": {
    "maxLeverage": 2,
    "minTradePct": 2,
    "slippageBps": 30,
    "maxPositionX": 1,
    "maxDailyLossPct": 3,
    "maxTotalLossPct": 10,
    "maxGrossExposureX": 1.5
   },
   "configVersion": 3,
   "strategy": {
    "name": "momentum_xs_perp",
    "version": "2",
    "sha256": "75cd4dfae65f6d55667bfaf3fe2eee2b5c98c18edbe8b43dcd8480d88262e272",
    "path": "strategies/momentum_xs_perp/2",
    "status": "approved",
    "kind": "python"
   },
   "mandate": null,
   "pausedFrom": null,
   "live": {
    "capable": true,
    "code": null,
    "reason": null
   },
   "stopReason": null,
   "lastBar": null,
   "createdAt": 1794953786472,
   "updatedAt": 1794955043180
  },
  "strategyVersionId": "450bc266-e1a9-4807-9113-7da6773ddb4e"
 },
 "getNftMarketEvents": {
  "key": "evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1",
  "sources": [
   {
    "status": {
     "provider": "opensea",
     "name": "OpenSea",
     "state": "needs_key",
     "code": "no_api_key",
     "unlockedBy": "OPENSEA_API_KEY",
     "stale": false,
     "stamp": null,
     "attribution": null
    },
    "events": [],
    "nextCursor": null
   }
  ],
  "rates": {},
  "asOf": "2026-11-17T22:37:24.187Z"
 },
 "errMandateDenied": {
  "error": "mandate_denied",
  "message": "the order is outside the mandate: ORDER_NOTIONAL_EXCEEDED",
  "data": {
   "reasons": [
    "ORDER_NOTIONAL_EXCEEDED"
   ],
   "order": {
    "id": "0xd51cebbed3c7d5e595f90d368ea832ad",
    "orderId": "0xd51cebbed3c7d5e595f90d368ea832ad",
    "mode": "paper",
    "venue": "hyperliquid",
    "network": "mainnet",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "clientId": "0xd51cebbed3c7d5e595f90d368ea832ad",
    "clientOrderId": "0xd51cebbed3c7d5e595f90d368ea832ad",
    "venueOrderId": null,
    "instrument": "hyperliquid:BTC",
    "side": "buy",
    "type": "market",
    "size": "0.01396",
    "price": "64749",
    "triggerPrice": null,
    "reduceOnly": false,
    "tif": "ioc",
    "status": "REJECTED",
    "final": true,
    "reasonCode": "MANDATE_DENIED",
    "reason": "the order is outside the mandate: ORDER_NOTIONAL_EXCEEDED",
    "rejectCode": "mandate_denied",
    "engineStatus": null,
    "filled": "0",
    "avgFillPrice": null,
    "acknowledged": false,
    "cancelRequested": false,
    "origin": "trading_api",
    "principal": {
     "kind": "api_key",
     "id": "spk_0123456789ab"
    },
    "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
    "engine": "paper",
    "engineRef": null,
    "hash": "1aee5a4cdfc23da98dd02b104acef0677437ba9d866a24cf53c509e00b6d6a40",
    "notionalUsd": "903.89604",
    "projectionError": null,
    "version": 1,
    "createdAt": 1794953731495,
    "updatedAt": 1794953731502
   }
  }
 },
 "errMandateRequired": {
  "error": "mandate_required",
  "message": "the scope orders:execute is inert on this key: no trading mandate is bound to it"
 },
 "errInsufficientScope": {
  "error": "insufficient_scope",
  "message": "this key lacks the scope wallet:read"
 },
 "errExecutionDisabled": {
  "error": "execution_disabled",
  "message": "live execution through the trading API is disabled on this server (SPW_TRADING_API_EXECUTION is not \"on\"); nothing was created. Cancels and strictly reducing orders still pass."
 },
 "errBadRequest": {
  "error": "bad_request",
  "message": "invalid request"
 },
 "errAmbiguousSymbol": {
  "error": "ambiguous_symbol",
  "message": "'BTC' exists on several venues: name one of the candidates as venue:symbol",
  "candidates": [
   "dydx:BTC-USD",
   "edgex:BTCUSDC"
  ]
 },
 "errNotFound": {
  "error": "not_found",
  "message": "no such operation in the trading API: see GET /api/v1/trading/openapi.json"
 },
 "errKillSwitch": {
  "error": "kill_switch_active",
  "message": "kill_switch: the kill switch is on: no new risk",
  "data": {
   "failed": [
    "kill_switch"
   ],
   "checks": [
    {
     "id": "kill_switch",
     "ok": false,
     "observed": "true",
     "limit": "false",
     "detail": "the kill switch is on: no new risk",
     "exempt": false
    }
   ],
   "decisionId": 21,
   "order": {
    "id": "0x6f3d33c8d9a43c3e0bf5a17784a5c1a7",
    "orderId": "0x6f3d33c8d9a43c3e0bf5a17784a5c1a7",
    "mode": "paper",
    "venue": "hyperliquid",
    "network": "mainnet",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "clientId": "0x6f3d33c8d9a43c3e0bf5a17784a5c1a7",
    "clientOrderId": "0x6f3d33c8d9a43c3e0bf5a17784a5c1a7",
    "venueOrderId": null,
    "instrument": "hyperliquid:BTC",
    "side": "buy",
    "type": "market",
    "size": "0.00155",
    "price": "64754",
    "triggerPrice": null,
    "reduceOnly": false,
    "tif": "ioc",
    "status": "REJECTED",
    "final": true,
    "reasonCode": "KILL_SWITCH_ACTIVE",
    "reason": "kill_switch: the kill switch is on: no new risk",
    "rejectCode": "kill_switch_active",
    "engineStatus": null,
    "filled": "0",
    "avgFillPrice": null,
    "acknowledged": false,
    "cancelRequested": false,
    "origin": "trading_api",
    "principal": {
     "kind": "api_key",
     "id": "spk_0123456789ab"
    },
    "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
    "engine": "paper",
    "engineRef": null,
    "hash": "ea251eb6fc7f290e903f8c8a23dc307c80181d4d35ee320e9d7aa65622218b3f",
    "notionalUsd": "100.3687",
    "projectionError": null,
    "version": 1,
    "createdAt": 1794953766532,
    "updatedAt": 1794953766906
   }
  }
 },
 "errIdempotencyConflict": {
  "error": "idempotency_conflict",
  "message": "this Idempotency-Key was used with a different request"
 },
 "errIdempotencyMissing": {
  "error": "idempotency",
  "message": "an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required"
 },
 "errParse": {
  "error": "parse_error",
  "message": "unknown command",
  "data": {
   "code": "unknown_command",
   "token": 0
  }
 },
 "errRateLimited": {
  "error": "rate_limited",
  "message": "too many requests for this key"
 },
 "errAmbiguousCommand": {
  "error": "ambiguous_command",
  "message": "the command and the owner's defaults do not settle everything: answer the questions (or set the defaults) and send it again. Nothing was executed.",
  "data": {
   "questions": [
    {
     "field": "network",
     "options": [
      "mainnet"
     ],
     "message": "on which network? The defaults name none for BTC-PERP"
    },
    {
     "field": "orderTtlMs",
     "options": [],
     "message": "no order validity is pre-approved: how long may the order wait before it is sent?"
    }
   ]
  }
 },
 "errPriceDeviation": {
  "error": "price_deviation",
  "message": "price 51000 is more than 200 bps away from the mark 64433",
  "data": {
   "order": {
    "id": "0x47153d4b344f5ce33015c6f49e86a967",
    "orderId": "0x47153d4b344f5ce33015c6f49e86a967",
    "mode": "paper",
    "venue": "hyperliquid",
    "network": "mainnet",
    "accountId": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2",
    "clientId": "0x47153d4b344f5ce33015c6f49e86a967",
    "clientOrderId": "0x47153d4b344f5ce33015c6f49e86a967",
    "venueOrderId": null,
    "instrument": "hyperliquid:BTC",
    "side": "buy",
    "type": "limit",
    "size": "0.001",
    "price": "51000",
    "triggerPrice": null,
    "reduceOnly": false,
    "tif": "gtc",
    "status": "REJECTED",
    "final": true,
    "reasonCode": "RISK_DENIED",
    "reason": "price 51000 is more than 200 bps away from the mark 64433",
    "rejectCode": "price_deviation",
    "engineStatus": null,
    "filled": "0",
    "avgFillPrice": null,
    "acknowledged": false,
    "cancelRequested": false,
    "origin": "trading_api",
    "principal": {
     "kind": "api_key",
     "id": "spk_0123456789ab"
    },
    "mandateId": "84f954ea-0c25-4985-bc19-901d510964d7",
    "engine": "paper",
    "engineRef": "6a2c8351-cd79-44e2-b75a-f39280d0ebc2:0x47153d4b344f5ce33015c6f49e86a967",
    "hash": "2ae60058a0750a836b9f4a7b3ca79abd6001052cb5e6bc5d1209a11389708e49",
    "notionalUsd": "51",
    "projectionError": null,
    "version": 4,
    "createdAt": 1794953757005,
    "updatedAt": 1794953757202
   }
  }
 }
};
