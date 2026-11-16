// @spw/trading — deterministic core of the V11 trading layer. Pure code: no I/O, no clock except an injected `now`, no randomness.
// Docs: docs/V11-EXECUTION-ENGINE.md, docs/V11-RISK-MODEL.md, docs/TRADING-MANDATES.md.
export * from './dec.ts';
export * from './orders/canonical.ts';
export * from './orders/state.ts';
export * from './orders/idempotency.ts';
export * from './orders/vocabulary.ts';
export * from './risk/engine.ts';
