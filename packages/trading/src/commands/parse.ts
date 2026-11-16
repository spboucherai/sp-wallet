/**
 * Trading command engine: a deterministic grammar, a hand-written tokenizer and parser, no model, no guess.
 *
 *   BUY <asset> <amount> <quote> [ON <venue>]            spend <amount> of <quote> to buy <asset> (spot)
 *   SELL <asset> <amount|pct%> [FOR <quote>] [ON <venue>] sell a quantity of <asset>, or a share of the balance (spot)
 *   LONG|SHORT <asset>-PERP <notional> [x<lev>] [LIMIT <px>] [SL <px>] [TP <px>] [ON <venue>]
 *   CLOSE <asset>-PERP [pct%] [ON <venue>]
 *   CANCEL ORDER <id>            CANCEL ALL [ON <venue>]
 *   SHOW POSITIONS|BALANCES|ORDERS|RISK
 *   STOP ALL AGENTS              KILL
 *
 * Keywords are case-insensitive and exist in English and French (KEYWORDS below). Numbers are plain decimals: no sign, no
 * exponent, no thousands separator, no leading zero. Anything else is a parse error — never an order.
 *
 * `parse` gives a typed AST. `resolve` turns it into a canonical order, a query or a control — or into QUESTIONS. Nothing is
 * guessed: the venue, the network, the fee cap, the slippage bound, the leverage and the margin mode come from the command or
 * from the owner's explicit `defaults`; when neither says, the result is `ambiguous`. Several instruments matching → ambiguous.
 *
 * Pure: the clock is `request.now`; no randomness (the client order id is derived from the idempotency key).
 */
import { D, type DecStr, type MarginMode } from '@spw/derivatives';
import { canon, cmpStr } from '../dec.ts';
import { canonicalOrder, canonicalOrderHashHex, ORDER_MAX_TTL_MS, type CanonicalOrder, type CanonicalOrderInput, type MarketKind, type Principal, type TradingMode } from '../orders/canonical.ts';
import { clientOrderIdFor, IdempotencyError } from '../orders/idempotency.ts';

// ------------------------------------------------------------------------------------------------------------------ AST

export type Amount = { kind: 'abs'; value: DecStr } | { kind: 'pct'; value: DecStr };
export type QueryTopic = 'positions' | 'balances' | 'orders' | 'risk';
export type Command =
  | { type: 'spot_buy'; asset: string; amount: DecStr; quote: string; venue: string | null }
  | { type: 'spot_sell'; asset: string; amount: Amount; quote: string | null; venue: string | null }
  | { type: 'perp_open'; side: 'long' | 'short'; asset: string; notional: DecStr; leverage: DecStr | null; limit: DecStr | null; stopLoss: DecStr | null; takeProfit: DecStr | null; venue: string | null }
  | { type: 'perp_close'; asset: string; pct: DecStr | null; venue: string | null }
  | { type: 'cancel_order'; id: string }
  | { type: 'cancel_all'; venue: string | null }
  | { type: 'show'; topic: QueryTopic }
  | { type: 'stop_all_agents' }
  | { type: 'kill' };

export const PARSE_ERROR_CODES = ['empty', 'too_long', 'bad_character', 'unknown_command', 'expected_asset', 'expected_perp', 'expected_amount', 'expected_quote', 'expected_price', 'expected_venue',
  'expected_keyword', 'expected_id', 'bad_number', 'bad_percent', 'bad_leverage', 'duplicate_option', 'unexpected_token'] as const;
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];
export interface ParseError { code: ParseErrorCode; message: string; /** index of the offending token, or the number of tokens when the input ends too early */ token: number }
export type ParseResult = { ok: true; command: Command } | { ok: false; error: ParseError };

// ------------------------------------------------------------------------------------------------------------------ tokens

export const MAX_COMMAND_LENGTH = 300;
/** keyword → every accepted spelling (upper case, accents removed) */
export const KEYWORDS = {
  BUY: ['BUY', 'ACHETER', 'ACHETE'], SELL: ['SELL', 'VENDRE', 'VENDS'], LONG: ['LONG'], SHORT: ['SHORT'], CLOSE: ['CLOSE', 'FERMER', 'FERME', 'CLOTURER'],
  CANCEL: ['CANCEL', 'ANNULER', 'ANNULE'], ORDER: ['ORDER', 'ORDRE'], ALL: ['ALL', 'TOUT', 'TOUS', 'TOUTES'], ON: ['ON', 'SUR'], FOR: ['FOR', 'CONTRE', 'POUR'],
  SHOW: ['SHOW', 'AFFICHER', 'AFFICHE', 'VOIR', 'MONTRER', 'MONTRE'], POSITIONS: ['POSITIONS'], BALANCES: ['BALANCES', 'SOLDES'], ORDERS: ['ORDERS', 'ORDRES'], RISK: ['RISK', 'RISQUE', 'RISQUES'],
  STOP: ['STOP', 'ARRETER', 'ARRETE', 'STOPPER'], AGENTS: ['AGENTS'], THE: ['THE', 'LES'], KILL: ['KILL', 'URGENCE'], LIMIT: ['LIMIT', 'LIMITE'], SL: ['SL'], TP: ['TP'],
} as const;
type Keyword = keyof typeof KEYWORDS;
const KEYWORD_OF = new Map<string, Keyword>();
for (const k of Object.keys(KEYWORDS) as Keyword[]) for (const w of KEYWORDS[k]) KEYWORD_OF.set(w, k);

interface Token { raw: string; up: string }
const NUMBER = /^(0|[1-9]\d{0,29})(\.\d{1,18})?$/;
const ASSET = /^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{1,15}$/;
const VENUE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function tokenize(input: string): Token[] | ParseError {
  if (typeof input !== 'string') return { code: 'empty', message: 'a command is a line of text', token: 0 };
  if (input.length > MAX_COMMAND_LENGTH) return { code: 'too_long', message: `a command is at most ${MAX_COMMAND_LENGTH} characters`, token: 0 };
  // printable characters and plain spaces only: no control character, no line break, no invisible separator
  if (/[^\x20-\x7eÀ-ſ]/.test(input)) return { code: 'bad_character', message: 'a command is one line of plain text', token: 0 };
  const raws = input.split(' ').filter((x) => x.length > 0);
  if (raws.length === 0) return { code: 'empty', message: 'the command is empty', token: 0 };
  return raws.map((raw) => ({ raw, up: raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase() }));
}

class Parser {
  i = 0;
  constructor(readonly t: Token[]) {}
  peek(): Token | undefined { return this.t[this.i]; }
  kw(): Keyword | undefined { const x = this.peek(); return x ? KEYWORD_OF.get(x.up) : undefined; }
  take(k: Keyword): boolean { if (this.kw() === k) { this.i += 1; return true; } return false; }
  err(code: ParseErrorCode, message: string): never { throw Object.assign(new Error(message), { parse: { code, message, token: this.i } satisfies ParseError }); }
  need(k: Keyword): void { if (!this.take(k)) this.err('expected_keyword', `expected ${k}`); }
  number(code: ParseErrorCode, what: string): DecStr {
    const x = this.peek();
    if (!x) this.err(code, `expected ${what}`);
    if (!NUMBER.test(x.raw)) this.err('bad_number', `${what} must be a plain positive decimal number`);
    const v = canon(x.raw);
    if (!D.isPos(D.from(v))) this.err('bad_number', `${what} must be positive`);
    this.i += 1;
    return v;
  }
  percent(): DecStr | null {
    const x = this.peek();
    if (!x || !x.raw.endsWith('%')) return null;
    const body = x.raw.slice(0, -1);
    if (!NUMBER.test(body)) this.err('bad_percent', 'a percentage is a plain number followed by %');
    const v = canon(body);
    if (!D.isPos(D.from(v)) || D.gt(D.from(v), D.from(100n))) this.err('bad_percent', 'a percentage is above 0 and at most 100');
    this.i += 1;
    return v;
  }
  asset(code: ParseErrorCode = 'expected_asset'): string {
    const x = this.peek();
    if (!x || !ASSET.test(x.up) || KEYWORD_OF.has(x.up)) this.err(code, 'expected an asset symbol');
    this.i += 1;
    return x.up;
  }
  perp(): string {
    const x = this.peek();
    if (!x || !x.up.endsWith('-PERP')) this.err('expected_perp', 'expected <asset>-PERP');
    const a = x.up.slice(0, -5);
    if (!ASSET.test(a)) this.err('expected_perp', 'expected <asset>-PERP');
    this.i += 1;
    return a;
  }
  venue(): string {
    const x = this.peek();
    const v = x?.raw.toLowerCase();
    if (!x || v === undefined || !VENUE.test(v)) this.err('expected_venue', 'expected a venue name after ON');
    this.i += 1;
    return v;
  }
  optVenue(): string | null { return this.take('ON') ? this.venue() : null; }
  end(): void { if (this.i < this.t.length) this.err('unexpected_token', `unexpected "${this.peek()!.raw.slice(0, 40)}"`); }
}

function leverageOf(x: Token): DecStr | null | 'bad' {
  const m = /^X(.+)$/.exec(x.up) ?? /^(.+)X$/.exec(x.up);
  if (!m) return null;
  if (!NUMBER.test(m[1]!)) return 'bad';
  const v = canon(m[1]!);
  return D.gte(D.from(v), D.one) ? v : 'bad';
}

function parseTokens(p: Parser): Command {
  const k = p.kw();
  if (k === undefined) p.err('unknown_command', 'unknown command');
  p.i += 1;
  switch (k) {
    case 'BUY': {
      const asset = p.asset(), amount = p.number('expected_amount', 'the amount'), quote = p.asset('expected_quote'), venue = p.optVenue();
      p.end();
      return { type: 'spot_buy', asset, amount, quote, venue };
    }
    case 'SELL': {
      const asset = p.asset();
      const pct = p.percent();
      const amount: Amount = pct !== null ? { kind: 'pct', value: pct } : { kind: 'abs', value: p.number('expected_amount', 'the amount') };
      const quote = p.take('FOR') ? p.asset('expected_quote') : null, venue = p.optVenue();
      p.end();
      return { type: 'spot_sell', asset, amount, quote, venue };
    }
    case 'LONG': case 'SHORT': {
      const asset = p.perp(), notional = p.number('expected_amount', 'the notional');
      let leverage: DecStr | null = null, limit: DecStr | null = null, stopLoss: DecStr | null = null, takeProfit: DecStr | null = null, venue: string | null = null;
      const once = (x: unknown, what: string) => { if (x !== null) p.err('duplicate_option', `${what} is given twice`); };
      for (let x = p.peek(); x !== undefined; x = p.peek()) {
        const kw = p.kw();
        if (kw === 'LIMIT') { once(limit, 'LIMIT'); p.i += 1; limit = p.number('expected_price', 'the limit price'); }
        else if (kw === 'SL') { once(stopLoss, 'SL'); p.i += 1; stopLoss = p.number('expected_price', 'the stop-loss price'); }
        else if (kw === 'TP') { once(takeProfit, 'TP'); p.i += 1; takeProfit = p.number('expected_price', 'the take-profit price'); }
        else if (kw === 'ON') { once(venue, 'ON'); p.i += 1; venue = p.venue(); }
        else {
          const lev = leverageOf(x);
          if (lev === null) p.err('unexpected_token', `unexpected "${x.raw.slice(0, 40)}"`);
          if (lev === 'bad') p.err('bad_leverage', 'leverage is written x<number>, at least 1');
          once(leverage, 'the leverage'); p.i += 1; leverage = lev;
        }
      }
      return { type: 'perp_open', side: k === 'LONG' ? 'long' : 'short', asset, notional, leverage, limit, stopLoss, takeProfit, venue };
    }
    case 'CLOSE': {
      const asset = p.perp(), pct = p.percent(), venue = p.optVenue();
      p.end();
      return { type: 'perp_close', asset, pct, venue };
    }
    case 'CANCEL': {
      if (p.take('ALL')) { const venue = p.optVenue(); p.end(); return { type: 'cancel_all', venue }; }
      p.need('ORDER');
      const x = p.peek();
      if (!x || !ORDER_ID.test(x.raw)) p.err('expected_id', 'expected an order id');
      p.i += 1; p.end();
      return { type: 'cancel_order', id: x.raw };
    }
    case 'SHOW': {
      const what = p.kw();
      const topic: QueryTopic | null = what === 'POSITIONS' ? 'positions' : what === 'BALANCES' ? 'balances' : what === 'ORDERS' ? 'orders' : what === 'RISK' ? 'risk' : null;
      if (topic === null) p.err('expected_keyword', 'expected POSITIONS, BALANCES, ORDERS or RISK');
      p.i += 1; p.end();
      return { type: 'show', topic };
    }
    case 'STOP': { p.need('ALL'); p.take('THE'); p.need('AGENTS'); p.end(); return { type: 'stop_all_agents' }; }
    case 'KILL': { p.end(); return { type: 'kill' }; }
    default: return p.err('unknown_command', 'unknown command');
  }
}

export function parse(input: string): ParseResult {
  const t = tokenize(input);
  if (!Array.isArray(t)) return { ok: false, error: t };
  const p = new Parser(t);
  try { return { ok: true, command: parseTokens(p) }; } catch (e) {
    const pe = (e as { parse?: ParseError }).parse;
    if (pe) return { ok: false, error: pe };
    throw e;
  }
}

/** the command in its canonical English spelling: `parse(format(c))` gives back `c` */
export function format(c: Command): string {
  const on = (v: string | null) => (v === null ? '' : ` ON ${v}`);
  switch (c.type) {
    case 'spot_buy': return `BUY ${c.asset} ${c.amount} ${c.quote}${on(c.venue)}`;
    case 'spot_sell': return `SELL ${c.asset} ${c.amount.kind === 'pct' ? `${c.amount.value}%` : c.amount.value}${c.quote === null ? '' : ` FOR ${c.quote}`}${on(c.venue)}`;
    case 'perp_open': return `${c.side === 'long' ? 'LONG' : 'SHORT'} ${c.asset}-PERP ${c.notional}${c.leverage === null ? '' : ` x${c.leverage}`}${c.limit === null ? '' : ` LIMIT ${c.limit}`}${c.stopLoss === null ? '' : ` SL ${c.stopLoss}`}${c.takeProfit === null ? '' : ` TP ${c.takeProfit}`}${on(c.venue)}`;
    case 'perp_close': return `CLOSE ${c.asset}-PERP${c.pct === null ? '' : ` ${c.pct}%`}${on(c.venue)}`;
    case 'cancel_order': return `CANCEL ORDER ${c.id}`;
    case 'cancel_all': return `CANCEL ALL${on(c.venue)}`;
    case 'show': return `SHOW ${c.topic.toUpperCase()}`;
    case 'stop_all_agents': return 'STOP ALL AGENTS';
    case 'kill': return 'KILL';
  }
}

// ------------------------------------------------------------------------------------------------------------------ resolve

/** the owner's pre-approved resolution rules. Every member is optional: what is absent is ASKED, never assumed. */
export interface ResolutionDefaults {
  /** network used for spot orders */
  spotNetwork?: string;
  /** default spot venue per network */
  spotVenueByNetwork?: Readonly<Record<string, string>>;
  /** quote asset a SELL is paid in when the command does not say FOR */
  spotQuote?: string;
  /** quote assets counted one for one as USD when a fee cap is computed (e.g. USDC, USDT) */
  usdQuotes?: readonly string[];
  /** default perp venue, and the network of the account on each perp venue */
  perpVenue?: string;
  perpNetworkByVenue?: Readonly<Record<string, string>>;
  perpLeverage?: DecStr;
  perpMarginMode?: MarginMode;
  /** fee cap, basis points of the order's USD notional */
  maxFeeBps?: number;
  maxSlippageBps?: number;
  /** life of the order between creation and expiry, ms */
  orderTtlMs?: number;
}
export interface CatalogInstrument { id: string; venue: string; network: string; marketKind: MarketKind; base: string; quote: string; lotSize?: DecStr }
/** what the caller knows about the market and the accounts; nothing here is fetched */
export interface Catalog {
  instruments: readonly CatalogInstrument[];
  /** spot balances, in units of the asset */
  balances?: readonly { network: string; asset: string; amount: DecStr }[];
  /** open perp positions */
  positions?: readonly { instrument: string; side: 'long' | 'short'; size: DecStr }[];
  /** USD price of one unit of the instrument's base asset, to turn a size into a USD notional for the fee cap */
  referencePricesUsd?: Readonly<Record<string, DecStr>>;
}
export interface ResolveRequest { now: number; principal: Principal; mandateId: string | null; mode: TradingMode; idempotencyKey: string }

export const QUESTION_FIELDS = ['venue', 'network', 'instrument', 'quote', 'leverage', 'marginMode', 'maxFeeBps', 'maxSlippageBps', 'orderTtlMs'] as const;
export type QuestionField = (typeof QUESTION_FIELDS)[number];
export interface Question { field: QuestionField; /** the known candidates; empty = a free value is needed */ options: string[]; message: string }
export const UNRESOLVABLE_CODES = ['no_instrument', 'no_position', 'missing_balance', 'missing_reference_price', 'fee_cap_not_expressible', 'zero_size', 'inconsistent_prices', 'no_client_id_format', 'invalid_order'] as const;
export type UnresolvableCode = (typeof UNRESOLVABLE_CODES)[number];
export type Control = { type: 'cancel_order'; id: string } | { type: 'cancel_all'; venue: string | null } | { type: 'stop_all_agents' } | { type: 'kill_switch_on' };
export type Resolution =
  | { kind: 'order'; order: CanonicalOrder; hash: string; attached: { role: 'stop_loss' | 'take_profit'; order: CanonicalOrder; hash: string }[] }
  | { kind: 'query'; query: QueryTopic }
  | { kind: 'control'; control: Control }
  | { kind: 'ambiguous'; questions: Question[] }
  | { kind: 'unresolvable'; code: UnresolvableCode; message: string };

class Unresolvable extends Error { constructor(readonly code: UnresolvableCode, message: string) { super(message); } }
const get = <T>(r: Readonly<Record<string, T>> | undefined, k: string): T | undefined => (r !== undefined && Object.hasOwn(r, k) ? r[k] : undefined);
const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort(cmpStr);
const HUNDRED = D.from(100n), TEN_K = D.from(10000n);

interface Pick1 { instrument: CatalogInstrument | null; questions: Question[] }
/** narrows the catalog to one instrument; the venue and the network come from the command or the defaults only */
function pick(cands: readonly CatalogInstrument[], venue: string | undefined, network: string | undefined, what: string): Pick1 {
  const q: Question[] = [];
  if (cands.length === 0) throw new Unresolvable('no_instrument', `no instrument in the catalog matches ${what}`);
  if (venue === undefined) q.push({ field: 'venue', options: uniq(cands.map((c) => c.venue)), message: `on which venue? Neither the command nor the defaults name one for ${what}` });
  const onVenue = venue === undefined ? cands : cands.filter((c) => c.venue === venue);
  if (venue !== undefined && onVenue.length === 0) throw new Unresolvable('no_instrument', `no instrument on ${venue} matches ${what}`);
  if (network === undefined) q.push({ field: 'network', options: uniq(onVenue.map((c) => c.network)), message: `on which network? The defaults name none for ${what}` });
  if (q.length) return { instrument: null, questions: q };
  const final = onVenue.filter((c) => c.network === network);
  if (final.length === 0) throw new Unresolvable('no_instrument', `no instrument on ${venue} (${network}) matches ${what}`);
  if (final.length > 1) return { instrument: null, questions: [{ field: 'instrument', options: uniq(final.map((c) => c.id)), message: `several instruments match ${what}` }] };
  return { instrument: final[0]!, questions: [] };
}

function bounds(d: ResolutionDefaults, q: Question[]): { maxFeeBps: number; maxSlippageBps: number; ttl: number } | null {
  const ok = (n: number | undefined, max: number): n is number => n !== undefined && Number.isInteger(n) && n >= 0 && n <= max;
  if (!ok(d.maxFeeBps, 10_000)) q.push({ field: 'maxFeeBps', options: [], message: 'no fee cap is pre-approved: what is the highest fee, in basis points of the notional?' });
  if (!ok(d.maxSlippageBps, 10_000)) q.push({ field: 'maxSlippageBps', options: [], message: 'no slippage bound is pre-approved: what is the worst slippage accepted, in basis points?' });
  if (d.orderTtlMs === undefined || !Number.isInteger(d.orderTtlMs) || d.orderTtlMs <= 0 || d.orderTtlMs > ORDER_MAX_TTL_MS) q.push({ field: 'orderTtlMs', options: [], message: 'no order validity is pre-approved: how long may the order wait before it is sent?' });
  return q.length ? null : { maxFeeBps: d.maxFeeBps!, maxSlippageBps: d.maxSlippageBps!, ttl: d.orderTtlMs! };
}
/** fee cap in USD: notional × bps / 10000, rounded DOWN to 6 decimals (a cap never rounds up) */
const feeCap = (notionalUsd: DecStr, bps: number): DecStr => D.str(D.div(D.mul(D.from(notionalUsd), D.from(BigInt(bps))), TEN_K, 6, 'down'));

function build(input: CanonicalOrderInput): { order: CanonicalOrder; hash: string } {
  try { const order = canonicalOrder(input); return { order, hash: canonicalOrderHashHex(order) }; } catch (e) {
    throw new Unresolvable('invalid_order', `the command does not make a valid order: ${e instanceof Error ? e.message.slice(0, 200) : 'invalid'}`);
  }
}
function cid(venue: string, r: ResolveRequest, suffix = ''): string {
  try { return clientOrderIdFor(venue, r.principal, `${r.idempotencyKey}${suffix}`); } catch (e) {
    if (e instanceof IdempotencyError) throw new Unresolvable(e.code === 'unknown_venue' ? 'no_client_id_format' : 'invalid_order', e.message);
    throw e;
  }
}

/**
 * Same command + same defaults + same catalog + same request → the same canonical order and the same hash, always.
 * `attached` holds the reduce-only stop-loss / take-profit orders of a LONG|SHORT: they are sized by the same notional and must
 * be placed only once the entry is filled (the executor sizes them to what was filled).
 */
export function resolve(command: Command, defaults: ResolutionDefaults, catalog: Catalog, request: ResolveRequest): Resolution {
  try {
    switch (command.type) {
      case 'show': return { kind: 'query', query: command.topic };
      case 'cancel_order': return { kind: 'control', control: { type: 'cancel_order', id: command.id } };
      case 'cancel_all': return { kind: 'control', control: { type: 'cancel_all', venue: command.venue } };
      case 'stop_all_agents': return { kind: 'control', control: { type: 'stop_all_agents' } };
      case 'kill': return { kind: 'control', control: { type: 'kill_switch_on' } };
      case 'spot_buy': case 'spot_sell': return resolveSpot(command, defaults, catalog, request);
      case 'perp_open': return resolvePerpOpen(command, defaults, catalog, request);
      case 'perp_close': return resolvePerpClose(command, defaults, catalog, request);
    }
  } catch (e) {
    if (e instanceof Unresolvable) return { kind: 'unresolvable', code: e.code, message: e.message };
    throw e;
  }
}

function head(i: CatalogInstrument, r: ResolveRequest, ttl: number) {
  return { v: 1 as const, venue: i.venue, network: i.network, instrument: i.id, marketKind: i.marketKind, mode: r.mode, principal: r.principal, mandateId: r.mandateId, createdAt: r.now, expiresAt: r.now + ttl };
}

function resolveSpot(c: Extract<Command, { type: 'spot_buy' | 'spot_sell' }>, d: ResolutionDefaults, cat: Catalog, r: ResolveRequest): Resolution {
  const q: Question[] = [];
  const quote = c.type === 'spot_buy' ? c.quote : c.quote ?? d.spotQuote;
  if (quote === undefined) q.push({ field: 'quote', options: uniq(cat.instruments.filter((i) => i.marketKind === 'spot' && i.base === c.asset).map((i) => i.quote)), message: `sell ${c.asset} for which asset? Neither the command (FOR …) nor the defaults say` });
  const network = d.spotNetwork, venue = c.venue ?? (network === undefined ? undefined : get(d.spotVenueByNetwork, network));
  const cands = cat.instruments.filter((i) => i.marketKind === 'spot' && i.base === c.asset && (quote === undefined || i.quote === quote));
  const p = pick(cands, venue, network, `${c.asset}${quote === undefined ? '' : `/${quote}`} (spot)`);
  // while the quote is unknown, "which instrument" is the same question asked twice
  q.push(...p.questions.filter((x) => quote !== undefined || x.field !== 'instrument'));
  const b = bounds(d, q);
  if (q.length || b === null || p.instrument === null || quote === undefined) return { kind: 'ambiguous', questions: q };
  const i = p.instrument;
  let size: DecStr | null = null, notional: DecStr | null = null, notionalUsd: DecStr;
  if (c.type === 'spot_buy') {
    notional = c.amount;
    if (!(d.usdQuotes ?? []).includes(quote)) throw new Unresolvable('fee_cap_not_expressible', `${quote} is not one of the quote assets the defaults count as USD: the fee cap cannot be expressed in USD`);
    notionalUsd = notional;
  } else {
    if (c.amount.kind === 'abs') size = c.amount.value;
    else {
      const bal = (cat.balances ?? []).filter((x) => x.network === i.network && x.asset === c.asset);
      if (bal.length !== 1) throw new Unresolvable('missing_balance', `the balance of ${c.asset} on ${i.network} is needed to sell a percentage of it`);
      size = D.str(D.div(D.mul(D.from(bal[0]!.amount), D.from(c.amount.value)), HUNDRED, 18, 'down'));
    }
    if (i.lotSize !== undefined && !(c.amount.kind === 'pct' && D.eq(D.from(c.amount.value), HUNDRED))) size = D.str(D.quantize(D.from(size), D.from(i.lotSize), 'down'));
    if (!D.isPos(D.from(size))) throw new Unresolvable('zero_size', 'the quantity to sell is zero');
    const px = get(cat.referencePricesUsd, i.id);
    if (px === undefined || !D.isPos(D.from(px))) throw new Unresolvable('missing_reference_price', `a USD reference price of ${i.id} is needed to express the fee cap`);
    notionalUsd = D.str(D.mul(D.from(size), D.from(px)));
  }
  const o = build({ ...head(i, r, b.ttl), side: c.type === 'spot_buy' ? 'buy' : 'sell', type: 'market', size, notional, limitPrice: null, triggerPrice: null, reduceOnly: false, tif: 'ioc',
    maxSlippageBps: b.maxSlippageBps, maxFeeUsd: feeCap(notionalUsd, b.maxFeeBps), leverage: null, marginMode: null, clientOrderId: cid(i.venue, r) });
  return { kind: 'order', ...o, attached: [] };
}

function perpInstrument(asset: string, venueCmd: string | null, d: ResolutionDefaults, cat: Catalog): Pick1 {
  const venue = venueCmd ?? d.perpVenue, network = venue === undefined ? undefined : get(d.perpNetworkByVenue, venue);
  return pick(cat.instruments.filter((i) => i.marketKind === 'perp' && i.base === asset), venue, network, `${asset}-PERP`);
}

function resolvePerpOpen(c: Extract<Command, { type: 'perp_open' }>, d: ResolutionDefaults, cat: Catalog, r: ResolveRequest): Resolution {
  const p = perpInstrument(c.asset, c.venue, d, cat), q = [...p.questions];
  const leverage = c.leverage ?? d.perpLeverage;
  if (leverage === undefined) q.push({ field: 'leverage', options: [], message: 'with which leverage? Neither the command (x<n>) nor the defaults say' });
  if (d.perpMarginMode === undefined) q.push({ field: 'marginMode', options: ['cross', 'isolated'], message: 'cross or isolated margin? The defaults do not say' });
  const b = bounds(d, q);
  if (q.length || b === null || p.instrument === null || leverage === undefined || d.perpMarginMode === undefined) return { kind: 'ambiguous', questions: q };
  const i = p.instrument, long = c.side === 'long';
  // the stop must be on the losing side of the entry and the target on the winning side, whenever an entry price is known
  const entry = c.limit ?? get(cat.referencePricesUsd, i.id) ?? null;
  const below = (a: DecStr, x: DecStr) => D.lt(D.from(a), D.from(x));
  if (entry !== null) {
    if (c.stopLoss !== null && (long ? !below(c.stopLoss, entry) : !below(entry, c.stopLoss))) throw new Unresolvable('inconsistent_prices', `the stop-loss of a ${c.side} must be ${long ? 'below' : 'above'} the entry price ${entry}`);
    if (c.takeProfit !== null && (long ? !below(entry, c.takeProfit) : !below(c.takeProfit, entry))) throw new Unresolvable('inconsistent_prices', `the take-profit of a ${c.side} must be ${long ? 'above' : 'below'} the entry price ${entry}`);
  }
  if (c.stopLoss !== null && c.takeProfit !== null && (long ? !below(c.stopLoss, c.takeProfit) : !below(c.takeProfit, c.stopLoss))) throw new Unresolvable('inconsistent_prices', 'the stop-loss and the take-profit are on the wrong sides of each other');
  const common = { ...head(i, r, b.ttl), size: null, notional: c.notional, maxSlippageBps: b.maxSlippageBps, maxFeeUsd: feeCap(c.notional, b.maxFeeBps), marginMode: d.perpMarginMode };
  const main = build({ ...common, side: long ? 'buy' : 'sell', type: c.limit === null ? 'market' : 'limit', limitPrice: c.limit, triggerPrice: null, reduceOnly: false, tif: c.limit === null ? 'ioc' : 'gtc', leverage, clientOrderId: cid(i.venue, r) });
  const attached: Extract<Resolution, { kind: 'order' }>['attached'] = [];
  const exit = (role: 'stop_loss' | 'take_profit', trigger: DecStr, suffix: string) => attached.push({ role, ...build({ ...common, side: long ? 'sell' : 'buy', type: role === 'stop_loss' ? 'stop' : 'take_profit',
    limitPrice: null, triggerPrice: trigger, reduceOnly: true, tif: 'gtc', leverage: null, marginMode: null, clientOrderId: cid(i.venue, r, suffix) }) });
  if (c.stopLoss !== null) exit('stop_loss', c.stopLoss, ':sl');
  if (c.takeProfit !== null) exit('take_profit', c.takeProfit, ':tp');
  return { kind: 'order', ...main, attached };
}

function resolvePerpClose(c: Extract<Command, { type: 'perp_close' }>, d: ResolutionDefaults, cat: Catalog, r: ResolveRequest): Resolution {
  const p = perpInstrument(c.asset, c.venue, d, cat), q = [...p.questions];
  const b = bounds(d, q);
  if (q.length || b === null || p.instrument === null) return { kind: 'ambiguous', questions: q };
  const i = p.instrument, pos = (cat.positions ?? []).filter((x) => x.instrument === i.id);
  if (pos.length !== 1 || !D.isPos(D.from(pos[0]!.size))) throw new Unresolvable('no_position', `there is no open position on ${i.id} to close`);
  const full = c.pct === null || D.eq(D.from(c.pct), HUNDRED);
  let size = full ? canon(pos[0]!.size) : D.str(D.div(D.mul(D.from(pos[0]!.size), D.from(c.pct!)), HUNDRED, 18, 'down'));
  if (!full && i.lotSize !== undefined) size = D.str(D.quantize(D.from(size), D.from(i.lotSize), 'down'));
  if (!D.isPos(D.from(size))) throw new Unresolvable('zero_size', 'the quantity to close is zero');
  const px = get(cat.referencePricesUsd, i.id);
  if (px === undefined || !D.isPos(D.from(px))) throw new Unresolvable('missing_reference_price', `a USD reference price of ${i.id} is needed to express the fee cap`);
  const o = build({ ...head(i, r, b.ttl), side: pos[0]!.side === 'long' ? 'sell' : 'buy', type: 'market', size, notional: null, limitPrice: null, triggerPrice: null, reduceOnly: true, tif: 'ioc',
    maxSlippageBps: b.maxSlippageBps, maxFeeUsd: feeCap(D.str(D.mul(D.from(size), D.from(px))), b.maxFeeBps), leverage: null, marginMode: null, clientOrderId: cid(i.venue, r) });
  return { kind: 'order', ...o, attached: [] };
}

/** parse then resolve; a text that does not parse never reaches `resolve` */
export function interpret(input: string, defaults: ResolutionDefaults, catalog: Catalog, request: ResolveRequest): { parsed: ParseResult; resolution: Resolution | null } {
  const parsed = parse(input);
  return { parsed, resolution: parsed.ok ? resolve(parsed.command, defaults, catalog, request) : null };
}

/** the same functions under names that do not collide with other parsers */
export const parseCommand = parse, formatCommand = format, resolveCommand = resolve;
