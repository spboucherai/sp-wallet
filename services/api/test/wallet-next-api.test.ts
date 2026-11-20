// NEXT additions to the core wallet API, through the real server (own database, real signer, scripted chain and prices):
//   validation   a refused request says WHICH members and what is expected — never the value that was sent
//   activity     ?network=&asset= are applied in SQL before the limit; rows carry the contact's label
//   CSV          the appended columns, the positions of the earlier ones, formula-injection escaping
//   analytics    flows per asset / network split external · internal · ownAccounts, fiat only where a price was recorded,
//                fees paid with what the figure covers, outcomes, counterparties
//   search       assets, contacts, transactions; capped groups; hostile input
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootWallet, DEST, DEST_LOWER, USDC, type Wallet } from './wallet-helpers.ts';

let w: Wallet;
const get = (path: string) => w.api('GET', path);
const tx = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const STRANGER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', VAULT = '0x00000000000000000000000000000000000000A1';
/** the cells of one CSV line as they are written in the file (every cell is quoted; a quote inside a cell is doubled) */
const csvLine = (l: string): string[] => [...l.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) => m[1]!);
const DAY = 86_400_000, ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(async () => {
  w = await bootWallet('wallet_next_api');
  await w.setup();
});
afterAll(async () => { await w?.close(); });

describe('validation errors say which members were refused', () => {
  it('fields carry a path, a code and what is expected; the submitted value never comes back', async () => {
    const secret = 'correct-horse-battery-staple-SECRET';
    const r = await w.api('POST', '/api/v1/addressbook', { network: 'base', address: 12345, label: '', [secret]: secret });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'bad_request', message: 'invalid request' });
    const f = r.json.data.fields as { path: string; code: string; message: string }[];
    expect(f).toContainEqual({ path: 'address', code: 'invalid_type', message: 'expected string' });
    expect(f).toContainEqual({ path: 'label', code: 'too_small', message: 'too small: at least 1 characters' });
    expect(f).toContainEqual({ path: '', code: 'unrecognized_keys', message: 'the object has a member this route does not accept' });
    expect(JSON.stringify(r.json)).not.toContain('SECRET'); expect(JSON.stringify(r.json)).not.toContain('12345');
    for (const x of f) expect(Object.keys(x).sort()).toEqual(['code', 'message', 'path']);
  });

  it('query and enum refusals, a refinement, a union, and the cap', async () => {
    const q = await get('/api/v1/activity?limit=9999&network=');
    expect(q.json.data.fields).toEqual(expect.arrayContaining([{ path: 'limit', code: 'too_big', message: 'too big: at most 500' }, { path: 'network', code: 'too_small', message: 'too small: at least 1 characters' }]));
    const e = await w.api('PUT', '/api/v1/settings', { theme: 'a-value-that-must-not-echo', currency: 'EUR' });
    expect(e.json.data.fields).toEqual([{ path: 'currency', code: 'invalid_value', message: 'not one of the accepted values' }, { path: 'theme', code: 'invalid_value', message: 'not one of the accepted values' }]);
    expect(JSON.stringify(e.json)).not.toMatch(/must-not-echo|EUR/);
    const refine = await w.api('PUT', `/api/v1/assets/prefs/base/${USDC.id}`, {});
    expect(refine.json.data.fields).toEqual([{ path: '', code: 'custom', message: 'nothing to change' }]);
    const union = await w.api('POST', '/api/v1/alerts/read', { ids: 'everything-please' });
    expect(union.status).toBe(400); expect(union.json.data.fields[0]).toMatchObject({ code: 'invalid_union' }); expect(JSON.stringify(union.json)).not.toContain('everything-please');
    // a key of a free map that does not look like a member name is not echoed
    const odd = await w.api('PUT', '/api/v1/alerts/settings', { rules: { 'DROP TABLE alerts; -- <script>': 'yes' } });
    expect(odd.json.data.fields).toEqual([{ path: 'rules.*', code: 'invalid_type', message: 'expected boolean' }]);
    const many = await w.api('POST', '/api/v1/alerts/read', { ids: Array.from({ length: 60 }, () => 'x') });
    expect(many.status).toBe(400); expect(many.json.data.fields.length).toBeLessThanOrEqual(20);
  });

  it('other refusals keep their shape: a UserError has no `fields`, a malformed body is still `bad_request`', async () => {
    const u = await w.api('POST', '/api/v1/addressbook', { network: 'base', address: 'nope', label: 'x' });
    expect(u.json.error).toBe('bad_address'); expect(u.json.data).toBeUndefined();
    const raw = await w.app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { cookie: w.cookie(), origin: 'https://wallet.test', 'x-spw-csrf': '1', 'content-type': 'application/json' }, payload: '{not json' });
    expect(raw.statusCode).toBe(400); expect(raw.json()).toEqual({ error: 'bad_request', message: 'invalid request' });
  });
});

describe('activity: filter by network and asset, contact labels', () => {
  let oldUsdc = '', oldDeposit = '';
  beforeAll(async () => {
    await w.api('POST', '/api/v1/addressbook', { network: 'base', address: DEST, label: 'Alice' });
    await w.sql`insert into scan_cursor (network, cursor, finalized) values ('base', 1000, 900), ('ethereum', 1000, 900)`;
    // one OLD USDC transfer and one OLD USDC receipt, then 40 newer native operations and 40 newer native receipts on Base, and noise on Ethereum
    oldUsdc = await w.proposal({ created_at: ago(200), finalized_at: ago(200), txid: tx(1), fee_paid: '21000000000000' });
    oldDeposit = tx(2);
    await w.deposit({ txid: oldDeposit, asset: USDC.id, amount: '5000000', from: DEST_LOWER, at: ago(190), block: 10 });
    for (let k = 0; k < 40; k += 1) {
      await w.proposal({ asset: 'native', symbol: 'ETH', decimals: 18, amount: '1000000000000000', to_addr: STRANGER, created_at: ago(20 - k / 10), finalized_at: ago(20 - k / 10), txid: tx(100 + k) });
      await w.deposit({ txid: tx(200 + k), amount: '2000000000000000', from: STRANGER.toLowerCase(), at: ago(10 - k / 10), block: 20 + k });
    }
    await w.proposal({ network: 'ethereum', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1', created_at: ago(1), txid: tx(300) });
  });

  it('without a filter the newest rows win; with one, the old movements of that asset are reached', async () => {
    const latest = (await get('/api/v1/activity?limit=20')).json.items;
    expect(latest).toHaveLength(20); expect(latest.some((i: any) => i.asset === USDC.id)).toBe(false);          // the audit's W5: an asset page built from this is empty
    const usdc = (await get(`/api/v1/activity?limit=20&network=base&asset=${USDC.id}`)).json.items;
    expect(usdc.map((i: any) => [i.kind, i.kind === 'receive' ? i.txid : i.id])).toEqual([['receive', oldDeposit], ['send', oldUsdc]]);
    expect(usdc.every((i: any) => i.network === 'base' && i.asset === USDC.id)).toBe(true);
    // a token id is matched without case; the network alone; a network that has nothing; an asset on the wrong network
    expect((await get(`/api/v1/activity?network=base&asset=${USDC.id.toLowerCase()}`)).json.items).toHaveLength(2);
    const eth = (await get('/api/v1/activity?network=ethereum')).json.items;
    expect(eth).toHaveLength(1); expect(eth[0].network).toBe('ethereum');
    expect((await get('/api/v1/activity?network=solana')).json.items).toEqual([]);
    expect((await get(`/api/v1/activity?network=ethereum&asset=${USDC.id}`)).json.items).toEqual([]);
    const native = (await get('/api/v1/activity?network=base&asset=native&limit=500')).json.items;
    expect(native).toHaveLength(80); expect(native.every((i: any) => i.asset === 'native')).toBe(true);
  });

  it('the filter value is a bound parameter', async () => {
    for (const hostile of ["native' or '1'='1", 'native%', '%', "'; drop table proposals; --"]) {
      const r = await get(`/api/v1/activity?network=base&asset=${encodeURIComponent(hostile)}`);
      expect(r.status).toBe(200); expect(r.json.items).toEqual([]);
    }
    expect(Number((await w.sql`select count(*)::int as n from proposals`)[0].n)).toBe(42);
  });

  it('`contactLabel` is the address-book label of the counterparty — exact address, without case for an EVM address', async () => {
    const usdc = (await get(`/api/v1/activity?network=base&asset=${USDC.id}`)).json.items;
    expect(usdc.find((i: any) => i.kind === 'send')).toMatchObject({ to: DEST, contactLabel: 'Alice' });
    expect(usdc.find((i: any) => i.kind === 'receive')).toMatchObject({ from: DEST_LOWER, contactLabel: 'Alice' });     // the log gives lower case, the book is checksummed
    const native = (await get('/api/v1/activity?network=base&asset=native&limit=5')).json.items;
    expect(native.every((i: any) => i.contactLabel === null)).toBe(true);
    // the same address on another network is another contact; a case-sensitive address format is compared exactly
    const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
    await w.sql`insert into address_book (id, network, address, label) values (${crypto.randomUUID()}, 'solana', ${SOL}, 'Sol friend')`;
    await w.deposit({ network: 'solana', txid: 'solsig1', amount: '5', from: SOL, block: 5 }); await w.deposit({ network: 'solana', txid: 'solsig2', amount: '6', from: SOL.toLowerCase(), block: 6 });
    const sol = (await get('/api/v1/activity?network=solana')).json.items;
    expect(sol.map((i: any) => [i.txid, i.contactLabel]).sort()).toEqual([['solsig1', 'Sol friend'], ['solsig2', null]]);
    await w.sql`delete from deposits where network = 'solana'`;
  });

  it('the dashboard history takes the same filter and hands it to the wallet source', async () => {
    const all = (await get('/api/v1/dashboard/activity?limit=200')).json;
    expect(all.items.filter((i: any) => i.source === 'wallet').some((i: any) => i.wallet.asset === USDC.id)).toBe(true);   // 83 wallet rows: under the bound
    const only = (await get(`/api/v1/dashboard/activity?limit=200&network=base&asset=${USDC.id}`)).json;
    expect(only.items.map((i: any) => [i.kind, i.wallet.contactLabel])).toEqual([['receive', 'Alice'], ['transfer', 'Alice']]);
    const net = (await get('/api/v1/dashboard/activity?limit=200&network=ethereum')).json;
    expect(net.items.length).toBeGreaterThan(0); expect(net.items.every((i: any) => i.network === 'ethereum')).toBe(true);
    expect((await get('/api/v1/dashboard/activity?network=')).status).toBe(400);
  });
});

describe('CSV exports: appended columns', () => {
  it('/export/activity.csv keeps the earlier columns in place and appends seven', async () => {
    const evil = await w.proposal({ asset: 'native', symbol: 'ETH', decimals: 18, amount: '3', to_addr: VAULT, state: 'dropped', error_code: 'dropped', txid: tx(400), created_at: ago(2) });
    await w.sql`insert into address_book (id, network, address, label) values (${crypto.randomUUID()}, 'base', ${VAULT}, ${'=HYPERLINK("http://evil","x")'})`;
    await w.deposit({ txid: tx(401), asset: USDC.id, amount: '19900000', kind: 'internal', origin: 'swap', at: ago(3), block: 950 });
    const lines = (await get('/api/v1/export/activity.csv')).body.trim().split('\n');
    expect(lines[0]).toBe('time_utc,direction,network,symbol,amount_base_units,amount,counterparty,state,txid,fee_estimate_base_units,to_network,to_symbol,received,lifecycle,fee_paid_base_units,fee_paid,fee_symbol,deposit_kind,deposit_origin,contact_label');
    const row = (needle: string) => csvLine(lines.find((l) => l.includes(needle))!);
    for (const l of lines.slice(1)) expect(csvLine(l)).toHaveLength(20);
    // a final transfer with a recorded fee, to a contact
    expect(row(tx(1))).toEqual([expect.stringMatching(/^\d{4}-/), 'send', 'base', 'USDC', '25000000', '25', DEST, 'finalized', tx(1), '', '', '', '', 'confirmed', '21000000000000', '0.000021', 'ETH', '', '', 'Alice']);
    // no fee recorded: the cells are EMPTY (the estimate is not passed off as the fee paid)
    expect(row(tx(100)).slice(13)).toEqual(['confirmed', '', '', 'ETH', '', '', '']);
    // a dropped transfer: `state` keeps the stored word, `lifecycle` says dropped; the hostile label is neutralised
    expect(row(evil ? tx(400) : '')).toMatchObject({ 7: 'dropped', 13: 'dropped', 19: '\'=HYPERLINK(""http://evil"",""x"")' });
    // receipts: what they are, where they come from, who paid
    expect(row(tx(2))).toMatchObject({ 1: 'receive', 7: 'confirmed', 13: 'confirmed', 17: 'external', 18: '', 19: 'Alice' });
    expect(row(tx(401))).toMatchObject({ 13: 'confirming', 17: 'internal', 18: 'swap', 19: '' });
  });

  it('/dashboard/activity.csv appends six, filled for wallet rows only', async () => {
    const lines = (await get('/api/v1/dashboard/activity.csv')).body.trim().split('\n');
    expect(lines[0]).toBe('time_utc,kind,mode,venue,network,principal,code,instrument_or_asset,side,amount,amount_symbol,received,received_symbol,status,reference_type,reference_id,txid,explorer,lifecycle,fee_paid,fee_symbol,deposit_kind,deposit_origin,contact_label');
    const row = (needle: string) => csvLine(lines.find((l) => l.includes(needle))!);
    expect(row(tx(1)).slice(18)).toEqual(['confirmed', '0.000021', 'ETH', '', '', 'Alice']);
    expect(row(tx(100)).slice(18)).toEqual(['confirmed', '', '', '', '', '']);
    expect(row(tx(2)).slice(18)).toEqual(['confirmed', '', '', 'external', '', 'Alice']);
    expect(row(tx(401)).slice(18)).toEqual(['confirming', '', '', 'internal', 'swap', '']);
    expect(row(tx(400))[23]).toBe('\'=HYPERLINK(""http://evil"",""x"")');
    const audit = csvLine(lines.find((l) => l.includes('"security"'))!);
    expect(audit).toHaveLength(24); expect(audit.slice(18)).toEqual(['', '', '', '', '', '']);
    const filtered = (await get(`/api/v1/dashboard/activity.csv?network=base&asset=${USDC.id}`)).body.trim().split('\n');
    expect(filtered).toHaveLength(4);                                // header + the two old USDC movements + the internal receipt
  });

  it('a cell that starts with a formula character, a tab or a carriage return is neutralised', async () => {
    const { csvCell } = await import('../src/wallet-api/labels.ts');
    expect(['=1+1', '+1', '-1', '@x', '\tx', '\rx', 'plain', 'a"b', null, 12].map(csvCell)).toEqual(['"\'=1+1"', '"\'+1"', '"\'-1"', '"\'@x"', '"\'\tx"', '"\'\rx"', '"plain"', '"a""b"', '""', '"12"']);
  });
});

describe('analytics', () => {
  beforeAll(async () => {
    await w.sql`truncate proposals, deposits, portfolio_flows`; await w.sql`delete from address_book`;
    await w.api('POST', '/api/v1/addressbook', { network: 'base', address: DEST, label: 'Alice' });
    await w.sql`insert into agents (id, name, universe, risk, vault_index, vault_address) values (${crypto.randomUUID()}, 'Momentum', '[]', '{}', 1, ${VAULT})`;
    // OUT, final: 2 external USDC to Alice (one valued), 1 to a stranger, 1 to the agent vault (own account), 1 swap (internal), 1 self-transfer (internal)
    const a1 = await w.proposal({ amount: '10000000', created_at: ago(5), finalized_at: ago(5), txid: tx(1), fee_paid: '20000000000000' });
    await w.proposal({ amount: '15000000', created_at: ago(6), finalized_at: ago(6), txid: tx(2), fee_paid: '30000000000000' });
    await w.proposal({ amount: '1000000', to_addr: STRANGER, created_at: ago(7), finalized_at: ago(7), txid: tx(3) });                        // fee never recorded
    const own = await w.proposal({ amount: '40000000', to_addr: VAULT, created_at: ago(8), finalized_at: ago(8), txid: tx(4), fee_paid: '10000000000000' });
    await w.proposal({ kind: 'swap', asset: 'native', symbol: 'ETH', decimals: 18, amount: '500000000000000000', to_addr: '0x1111111254EEB25477B68fb85Ed929f73A960582', created_at: ago(9), finalized_at: ago(9), txid: tx(5), fee_paid: '50000000000000' });
    await w.proposal({ asset: 'native', symbol: 'ETH', decimals: 18, amount: '7', to_addr: w.me, created_at: ago(9), finalized_at: ago(9), txid: tx(6), fee_paid: '1' });
    // not final: counted in outcomes, never in flows
    await w.proposal({ state: 'dropped', error_code: 'dropped', amount: '999000000', created_at: ago(1), txid: tx(7) });
    await w.proposal({ state: 'failed', error_code: 'expired_onchain', amount: '999000000', created_at: ago(1), txid: tx(8) });
    await w.proposal({ state: 'failed', error_code: 'tx_failed', block_ref: '0xblock', amount: '999000000', created_at: ago(1), txid: tx(9) });      // reverted on-chain: a fee was paid, unknown here
    await w.proposal({ state: 'rejected', amount: '999000000', created_at: ago(1), idempotency_key: 'rej' });
    await w.proposal({ state: 'draft', amount: '999000000', created_at: ago(1), idempotency_key: 'draft' });
    await w.proposal({ amount: '77000000', created_at: ago(400), finalized_at: ago(400), txid: tx(10), fee_paid: '90000000000000' });                // outside 1Y
    // IN: external ETH from Alice (valued) and from a stranger (not valued), the swap's output (internal), a withdrawal from the agent vault (own account), an old one
    await w.deposit({ txid: tx(20), amount: '1500000000000000000', from: DEST_LOWER, at: ago(3.5) });
    await w.deposit({ txid: tx(21), amount: '250000000000000000', from: STRANGER.toLowerCase(), at: ago(4) });
    await w.deposit({ txid: tx(22), asset: USDC.id, amount: '990000000', from: '0x1111111254eeb25477b68fb85ed929f73a960582', kind: 'internal', origin: 'swap', at: ago(9) });
    await w.deposit({ txid: tx(23), asset: USDC.id, amount: '12000000', from: VAULT.toLowerCase(), kind: 'internal', origin: 'agent_withdrawal', at: ago(3) });
    await w.deposit({ txid: tx(24), amount: '9', from: STRANGER.toLowerCase(), at: ago(100) });
    await w.deposit({ txid: tx(25), amount: '3', kind: null, at: ago(2) });                                                                       // not classified yet, no sender
    // recorded prices (the rule of portfolio.ts): only these movements have a fiat value
    const flow = (ref_type: string, ref_id: string, direction: string, scope: string, asset: string, symbol: string, decimals: number, amount: string, usd: string, cad: string) =>
      w.sql`insert into portfolio_flows (ref_type, ref_id, at, direction, scope, network, asset, symbol, decimals, amount, price_usd, price_cad, priced_at) values (${ref_type}, ${ref_id}, now(), ${direction}, ${scope}, 'base', ${asset}, ${symbol}, ${decimals}, ${amount}, ${usd}, ${cad}, now())`;
    await flow('proposal', a1, 'out', 'external', USDC.id, 'USDC', 6, '10000000', '1.000100000000', '1.400000000000');
    await flow('proposal', own, 'out', 'own_account', USDC.id, 'USDC', 6, '40000000', '1', '1.4');
    await flow('deposit', `base:${tx(20)}:0:native`, 'in', 'external', 'native', 'ETH', 18, '1500000000000000000', '2000.123456789012', '2800');
    await flow('deposit', `base:${tx(23)}:0:${USDC.id}`, 'in', 'own_account', USDC.id, 'USDC', 6, '12000000', '1', '1.4');
    await w.sql`insert into portfolio_flows (ref_type, ref_id, at, direction, scope, network, asset, symbol, decimals, amount) values ('deposit', ${`base:${tx(21)}:0:native`}, now(), 'in', 'external', 'base', 'native', 'ETH', 18, '250000000000000000')`;
  });

  it('flows per asset: counts and base units per scope; fiat only where a price was recorded', async () => {
    const a = (await get('/api/v1/analytics?range=1M&currency=USD')).json;
    expect(a).toMatchObject({ range: '1M', currency: 'USD' }); expect(Date.parse(a.to) - Date.parse(a.from)).toBe(30 * DAY);
    const usdc = a.flows.byAsset.find((x: any) => x.asset === USDC.id), eth = a.flows.byAsset.find((x: any) => x.asset === 'native');
    expect(usdc).toMatchObject({ network: 'base', networkName: 'Base', symbol: 'USDC', decimals: 6 });
    // out: 10 + 15 + 1 external (only the 10 has a recorded price), 40 to the owner's own vault
    expect(usdc.out.external).toEqual({ count: 3, amount: '26000000', display: '26', value: '10.00', valued: 1, unvalued: 2 });
    expect(usdc.out.ownAccounts).toEqual({ count: 1, amount: '40000000', display: '40', value: '40.00', valued: 1, unvalued: 0 });
    expect(usdc.out.internal).toEqual({ count: 0, amount: '0', display: '0', value: null, valued: 0, unvalued: 0 });
    // in: the swap's output is internal (never valued), the vault withdrawal is the owner's own account
    expect(usdc.in.internal).toEqual({ count: 1, amount: '990000000', display: '990', value: null, valued: 0, unvalued: 1 });
    expect(usdc.in.ownAccounts).toEqual({ count: 1, amount: '12000000', display: '12', value: '12.00', valued: 1, unvalued: 0 });
    expect(usdc.in.external.count).toBe(0);
    // ETH in: 1.5 (valued at the recorded 2000.123456789012) + 0.25 + 3 wei unclassified (shown as external, like /activity); out: the swap leg and the self-transfer are internal
    expect(eth.in.external).toEqual({ count: 3, amount: '1750000000000000003', display: '1.750000000000000003', value: '3000.19', valued: 1, unvalued: 2 });
    expect(eth.out.internal).toEqual({ count: 2, amount: '500000000000000007', display: '0.500000000000000007', value: null, valued: 0, unvalued: 2 });
    expect(eth.out.external.count).toBe(0);
    expect(a.flows.byNetwork).toEqual([{ network: 'base', networkName: 'Base', in: { external: 3, internal: 1, ownAccounts: 1 }, out: { external: 3, internal: 2, ownAccounts: 1 } }]);
    expect(a.flows.fiat).toMatchObject({ method: 'price_recorded_when_seen',
      in: { external: { value: '3000.19', valued: 1, unvalued: 2, complete: false }, ownAccounts: { value: '12.00', valued: 1, unvalued: 0, complete: true } },
      out: { external: { value: '10.00', valued: 1, unvalued: 2, complete: false }, ownAccounts: { value: '40.00', valued: 1, unvalued: 0, complete: true } } });
    // the other currency uses the other recorded price
    const cad = (await get('/api/v1/analytics?range=1M&currency=CAD')).json;
    expect(cad.flows.fiat.in.external.value).toBe('4200.00'); expect(cad.flows.fiat.out.external.value).toBe('14.00');
    expect((await get('/api/v1/analytics')).json.currency).toBe('CAD');                                  // default: the account setting
    // nothing in the answer claims a return
    expect(JSON.stringify(a)).not.toMatch(/"(profit|pnl|return|performance|gain)[A-Za-z]*":/i); expect(a.disclaimer).toMatch(/nothing here is a realised return/);
  });

  it('fees: the sum of what was recorded, and how many transactions it does not cover', async () => {
    const a = (await get('/api/v1/analytics?range=1M')).json;
    // recorded: 20 + 30 + 10 + 50 gwei-thousands + 1 wei; unknown: the stranger's transfer (final, no fee) and the reverted one (in a block, no fee)
    expect(a.fees.byNetwork).toEqual([{ network: 'base', networkName: 'Base', symbol: 'ETH', decimals: 18, paid: '110000000000001', paidDisplay: '0.000110000000000001', known: 5, unknown: 2, complete: false }]);
    expect(a.fees.fiat).toBeNull(); expect(a.fees.covers).toMatch(/`unknown` counts the on-chain transactions without a recorded fee/);
    const all = (await get('/api/v1/analytics?range=ALL')).json;
    expect(all.from).toBeNull(); expect(all.fees.byNetwork[0]).toMatchObject({ paid: '200000000000001', known: 6, unknown: 2 });
  });

  it('outcomes by life cycle and by kind; ranges', async () => {
    const a = (await get('/api/v1/analytics?range=1M')).json;
    expect(a.outcomes.total).toBe(10);                               // the draft is not an operation
    expect(Object.fromEntries(a.outcomes.byLifecycle.map((x: any) => [x.lifecycle, x.count]))).toEqual({ confirmed: 6, dropped: 1, expired: 1, failed: 1, rejected: 1 });
    expect(Object.fromEntries(a.outcomes.byKind.map((x: any) => [x.kind, x.count]))).toEqual({ transfer: 9, swap: 1 });
    const year = (await get('/api/v1/analytics?range=1Y&currency=USD')).json, all = (await get('/api/v1/analytics?range=ALL&currency=USD')).json;
    expect(year.flows.byAsset.find((x: any) => x.asset === 'native').in.external.count).toBe(4);          // the 100-day-old deposit
    expect(year.outcomes.total).toBe(10); expect(all.outcomes.total).toBe(11);
    expect(all.flows.byAsset.find((x: any) => x.asset === USDC.id).out.external).toMatchObject({ count: 4, amount: '103000000', valued: 1, unvalued: 3 });
    for (const bad of ['1W', '1D', 'all', '']) expect((await get(`/api/v1/analytics?range=${bad}`)).status, bad).toBe(400);
    expect((await get('/api/v1/analytics?currency=EUR')).status).toBe(400);
  });

  it('counterparties: external only, with the contact label; ranked by count', async () => {
    const a = (await get('/api/v1/analytics?range=1M')).json.counterparties;
    expect(a).toMatchObject({ limit: 10, rankedBy: 'count' });
    expect(a.sentTo.map((c: any) => [c.address, c.contactLabel, c.count])).toEqual([[DEST, 'Alice', 2], [STRANGER, null, 1]]);       // not the vault, not the swap router, not the wallet itself
    expect(a.sentTo[0].assets).toEqual([{ asset: USDC.id, symbol: 'USDC', amount: '25000000', display: '25', count: 2 }]);
    expect(a.receivedFrom.map((c: any) => [c.address, c.contactLabel, c.count])).toEqual([[DEST_LOWER, 'Alice', 1], [STRANGER.toLowerCase(), null, 1]]);   // a deposit without a sender names nobody
    expect(a.receivedFrom[0].assets[0]).toMatchObject({ symbol: 'ETH', display: '1.5' });
  });

  it('reads the database only, and needs the owner session', async () => {
    const before = w.outbound.length;
    await get('/api/v1/analytics?range=ALL'); await get('/api/v1/search?q=alice');
    expect(w.outbound.length).toBe(before);
    expect((await w.api('GET', '/api/v1/analytics', undefined, { cookie: null })).status).toBe(401);
    expect((await w.api('GET', '/api/v1/search?q=alice', undefined, { cookie: null })).status).toBe(401);
    const key = await w.app.inject({ method: 'GET', url: '/api/v1/analytics', headers: { authorization: 'Bearer spw_live_0123456789abcdef_0123456789abcdef0123456789abcdef' } });
    expect(key.statusCode).toBeGreaterThanOrEqual(401); expect(key.statusCode).toBeLessThan(404);                // an API key opens nothing outside /api/v1/trading
  });
});

describe('search', () => {
  const s = async (q: string, extra = '') => (await get(`/api/v1/search?q=${encodeURIComponent(q)}${extra}`));
  beforeAll(async () => {
    await w.sql`insert into address_book (id, network, address, label, note) values (${crypto.randomUUID()}, 'base', ${STRANGER}, '100% legit_shop', 'pays the rent')`;
    await w.sql`update proposals set note = 'rent for June' where txid = ${tx(1)}`;
  });

  it('assets: symbol, name, network, contract address', async () => {
    const usdc = (await s('usdc')).json;
    expect(usdc).toMatchObject({ q: 'usdc', limit: 8 });
    expect(usdc.assets.items.length).toBe(8); expect(usdc.assets.truncated).toBe(true);                    // USDC exists on more than eight networks
    expect(usdc.assets.items.every((x: any) => x.type === 'asset' && x.symbol.toLowerCase().includes('usdc') && x.matched === 'symbol')).toBe(true);
    expect((await s('usd coin')).json.assets.items[0]).toMatchObject({ matched: 'name' });
    const byContract = (await s(USDC.id.slice(0, 12))).json.assets.items;
    expect(byContract).toEqual([{ type: 'asset', network: 'base', networkName: 'Base', asset: USDC.id, symbol: 'USDC', name: USDC.name, decimals: 6, matched: 'contract' }]);
    const net = (await s('Base', '&limit=25')).json.assets.items;
    expect(net.some((x: any) => x.network === 'base' && x.matched === 'network')).toBe(true);
    expect((await s('eth')).json.assets.items[0]).toMatchObject({ symbol: 'ETH' });                         // the exact symbol first
  });

  it('contacts: label, address, note', async () => {
    expect((await s('alice')).json.contacts.items).toEqual([expect.objectContaining({ type: 'contact', label: 'Alice', address: DEST, matched: 'label' })]);
    expect((await s(DEST.slice(0, 10).toLowerCase())).json.contacts.items[0]).toMatchObject({ label: 'Alice', matched: 'address' });
    expect((await s('rent')).json.contacts.items[0]).toMatchObject({ label: '100% legit_shop', matched: 'note' });
  });

  it('transactions: id prefix or whole (with or without 0x), address, exact amount, note', async () => {
    const whole = (await s(tx(1))).json.transactions.items;
    expect(whole).toEqual([expect.objectContaining({ type: 'proposal', kind: 'send', txid: tx(1), symbol: 'USDC', amount: '10000000', amountDisplay: '10', counterparty: DEST, contactLabel: 'Alice', lifecycle: 'confirmed', state: 'finalized', matched: 'txid' })]);
    expect((await s(tx(20).slice(2))).json.transactions.items).toEqual([expect.objectContaining({ type: 'deposit', id: `base:${tx(20)}:0`, kind: 'receive', txid: tx(20), amountDisplay: '1.5', contactLabel: 'Alice', lifecycle: null, matched: 'txid' })]);
    const prefix = (await s(tx(1).slice(0, 40), '&limit=25')).json.transactions;
    expect(prefix.items.length).toBeGreaterThan(10); expect(prefix.items.every((i: any) => i.matched === 'txid')).toBe(true);
    const byAddr = (await s(STRANGER.slice(0, 12).toLowerCase(), '&limit=25')).json.transactions.items;
    expect(byAddr.map((i: any) => [i.type, i.matched]).sort()).toEqual([['deposit', 'address'], ['deposit', 'address'], ['proposal', 'address']]);
    // an amount is matched exactly, in the asset's own unit: 1.5 ETH, 15 USDC, 0.25 with a decimal comma
    expect((await s('1.5')).json.transactions.items.map((i: any) => [i.symbol, i.amountDisplay, i.matched])).toEqual([['ETH', '1.5', 'amount']]);
    expect((await s('15')).json.transactions.items.map((i: any) => [i.symbol, i.amountDisplay])).toEqual([['USDC', '15']]);
    expect((await s('0,25')).json.transactions.items.map((i: any) => i.amountDisplay)).toEqual(['0.25']);
    expect((await s('june')).json.transactions.items).toEqual([expect.objectContaining({ txid: tx(1), matched: 'note' })]);
    // drafts are never found; results are newest first and capped
    expect((await s('999', '&limit=25')).json.transactions.items.every((i: any) => i.state !== 'draft')).toBe(true);
    const capped = (await s(tx(1).slice(0, 40), '&limit=3')).json.transactions;
    expect(capped.items).toHaveLength(3); expect(capped.truncated).toBe(true);
    expect(capped.items.map((i: any) => i.at)).toEqual([...capped.items.map((i: any) => i.at)].sort().reverse());
  });

  it('minimum length, maximum length, limits', async () => {
    for (const q of ['', ' ', 'a', ' a ']) { const r = await s(q); expect(r.status, JSON.stringify(q)).toBe(400); expect(r.json.error).toBe('bad_request'); }
    expect((await get('/api/v1/search')).json.data.fields).toEqual([{ path: 'q', code: 'invalid_type', message: 'expected string' }]);
    expect((await s('ab')).status).toBe(200);
    expect((await s('x'.repeat(120))).status).toBe(200);
    const long = await s('x'.repeat(121));
    expect(long.status).toBe(400); expect(long.json.data.fields).toEqual([{ path: 'q', code: 'too_big', message: 'too big: at most 120 characters' }]);
    expect((await s('x'.repeat(5000))).status).toBe(400);
    expect((await s('usdc', '&limit=26')).status).toBe(400); expect((await s('usdc', '&limit=0')).status).toBe(400);
    // short queries do not sweep addresses and transaction ids
    expect((await s('0x')).json.transactions.items).toEqual([]); expect((await s('0x')).json.contacts.items).toEqual([]);
  });

  it('hostile input: LIKE wildcards are literal, quotes and SQL are text, nothing is echoed into SQL', async () => {
    const count = async () => Number((await w.sql`select (select count(*) from proposals) + (select count(*) from deposits) + (select count(*) from address_book) as n`)[0].n);
    const before = await count();
    // `%` and `_` match themselves only: the one label that contains them, and nothing else
    for (const q of ['%%', '__', '%_', '_%_%', '\\%', '\\\\']) { const r = await s(q); expect(r.status, q).toBe(200); expect(r.json.transactions.items, q).toEqual([]); expect(r.json.contacts.items.length, q).toBe(0); }
    expect((await s('100%')).json.contacts.items.map((c: any) => c.label)).toEqual(['100% legit_shop']);
    expect((await s('legit_shop')).json.contacts.items).toHaveLength(1);
    expect((await s('legitXshop')).json.contacts.items).toHaveLength(0);                                     // `_` is not "any character"
    expect((await s('0x%')).json.transactions.items).toEqual([]); expect((await s('0x0_00')).json.transactions.items).toEqual([]);
    for (const q of ["' or '1'='1", "'; drop table proposals; --", '" or ""="', "alice' --", '\u0000\u0000', '${1+1}', '<script>alert(1)</script>', "1.5' or 1=1", '1e999', '-1', '0x' + 'f'.repeat(118), '%'.repeat(120), '💸'.repeat(40), 'a\nb\r\nc']) {
      const r = await s(q);
      expect([200, 400], JSON.stringify(q)).toContain(r.status);
      if (r.status === 200) { expect(r.json.transactions.items, JSON.stringify(q)).toEqual([]); expect(r.json.contacts.items, JSON.stringify(q)).toEqual([]); }
      else { expect(r.json.error).toBe('bad_request'); expect(JSON.stringify(r.json)).not.toContain('drop table'); }
    }
    // a control character is refused by validation (PostgreSQL would refuse a NUL: it must not become a 500) — in the search and in the activity filters
    for (const q of ['\u0000\u0000', 'ab\u0000', 'a\nb\r\nc', 'ab\u007f']) expect((await s(q)).json, JSON.stringify(q)).toMatchObject({ error: 'bad_request', data: { fields: [{ path: 'q', code: 'invalid_format' }] } });
    expect((await get('/api/v1/activity?network=base&asset=%00')).status).toBe(400); expect((await get('/api/v1/dashboard/activity?network=%00')).status).toBe(400);
    expect(await count()).toBe(before);
    expect((await s("alice' --")).json.q).toBe("alice' --");                                                  // the query is returned as data, JSON-encoded
    expect((await s('alice')).json.contacts.items).toHaveLength(1);                                           // and the tables are intact
  });
});

describe('the file itself', () => {
  it('stays inside the rate limit of one address (240 a minute): a 429 would be a false failure', async () => {
    const left = Number((await w.api('GET', '/api/v1/health/live', undefined, { cookie: null })).headers['x-ratelimit-remaining']);
    expect(left).toBeGreaterThan(20);
  });
});
