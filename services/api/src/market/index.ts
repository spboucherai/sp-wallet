// Market data engine: public surface for the rest of the API service (the trading engine uses getSeries and assertFresh).
export { SYMBOLS, INTERVALS, INTERVAL_MS, MarketDataError, SourceError, expectedLastTs, type Candle, type SeriesBar, type Interval, type MarketSymbol, type SourceId } from './types.ts';
export { getSeries, assertFresh, checkQuality, type Series } from './series.ts';
export { DEFAULT_QUALITY, DEFAULT_PRIORITY, type QualityOpts, type QualityReport } from './quality.ts';
export { startMarketWorker } from './worker.ts';
export { marketDataRoutes } from './routes.ts';
