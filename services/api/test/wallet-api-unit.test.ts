/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/wallet-api-unit.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// The wallet contract without a server: the generated files are current, the document is well formed, the catalogues are
// complete against the SOURCES (error codes thrown, warnings emitted, life-cycle and event vocabularies), and the validator
// the contract test relies on really refuses what it should.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALERT_DEFS, LIFECYCLES, STATES, lifecycleOf } from '@spw/core';
import { generateWalletTypes } from '../../../scripts/lib/gen-wallet-types.mts';
// @ts-expect-error -- a plain script (scripts/lib), no type declarations
import { filesOf, scan, userErrorsOf } from '../../../scripts/lib/scan-user-errors.mjs';
import { SV } from '../src/sv-texts.ts';
import { applyDocSections, buildWalletOpenApi, oaPath, walletDocSections, walletOpenApiJson } from '../src/wallet-api/openapi.ts';
import { ENUMS, errorsOf, EVENT_TYPES, OPERATIONS, OTHER_FAMILIES, PROPOSAL_OUTCOME_CODES, TRANSFER_WARNINGS, WALLET_ERRORS, type WalletOp } from '../src/wallet-api/spec.ts';
import { REPO_ROOT } from './test-db.ts';
import { violations } from './schema-validator.ts';

const SRC = join(REPO_ROOT, 'services/api/src'), read = (p: string): string => readFileSync(join(REPO_ROOT, p), 'utf8');
const doc = buildWalletOpenApi() as any;
/** events.ts `MIRRORED`, read from the source (the module opens a database connection when imported; this file starts nothing) */
const MIRRORED = new RegExp(/export const MIRRORED = \/(.+)\/;/.exec(read('services/api/src/events.ts'))![1]!);

describe('generated files', () => {
  it('the committed document, web types and guide sections are exactly what the code generates (run: npx tsx scripts/gen-openapi.mts)', () => {
    expect(read('docs/openapi/wallet-v1.json')).toBe(walletOpenApiJson());
    expect(walletOpenApiJson()).toBe(walletOpenApiJson());           // deterministic
    expect(read('apps/web/src/generated/wallet-api.ts')).toBe(generateWalletTypes(JSON.parse(walletOpenApiJson())));
    const guide = read('docs/next/SP-WALLET-API.md');
    expect(applyDocSections(guide)).toBe(guide);
    for (const name of Object.keys(walletDocSections())) expect(guide, name).toContain(`<!-- BEGIN GENERATED: ${name} -->`);
    expect(() => applyDocSections('no markers')).toThrow(/markers/);
  });

  it('the guide lists every operation, every error code and every life-cycle value', () => {
    const guide = read('docs/next/SP-WALLET-API.md');
    for (const o of OPERATIONS) expect(guide, o.id).toContain(`| ${o.method} | \`${oaPath(o.path)}\` |`);
    for (const code of Object.keys(doc['x-spw-error-catalog'])) expect(guide, code).toContain(`| \`${code}\` |`);
    for (const l of LIFECYCLES) expect(guide, l).toContain(`| \`${l}\` |`);
    expect(JSON.stringify(doc)).not.toContain('x-spw-changing');   // the credential / session routes are described as merged
  });
});

describe('the document', () => {
  it('is OpenAPI 3.1 with one entry per operation, unique ids, and only resolvable references', () => {
    expect(doc.openapi).toBe('3.1.0');
    const ids = OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`)).size).toBe(ids.length);
    let n = 0;
    for (const item of Object.values(doc.paths) as any[]) for (const o of Object.values(item) as any[]) { n += 1; expect(ids).toContain(o.operationId); expect(o.responses['200']).toBeTruthy(); }
    expect(n).toBe(ids.length);
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(100);
    for (const r of new Set(refs)) expect(doc.components.schemas[r], r).toBeTruthy();
    expect(JSON.stringify(doc.paths)).not.toMatch(/x-spw-(component|enum)"/);   // every marker was hoisted
    for (const name of ['Error', 'Proposal', 'ActivityOperation', 'ActivityReceipt', 'Contact', 'Alert', 'WalletEvent', 'Analytics', 'SearchResults', ...Object.keys(ENUMS)]) expect(doc.components.schemas[name], name).toBeTruthy();
  });

  it('every answer object is open (additive API) and every request body that the route validates strictly is closed', () => {
    const open = (node: any, at: string): void => {
      if (Array.isArray(node)) return node.forEach((x, i) => open(x, `${at}[${i}]`));
      if (node === null || typeof node !== 'object') return;
      if (node.type === 'object' && node.properties && Object.keys(node.properties).length) expect(node.additionalProperties, `${at}: an answer object must stay open`).not.toBe(false);
      for (const [k, v] of Object.entries(node)) open(v, `${at}.${k}`);
    };
    for (const [name, s] of Object.entries(doc.components.schemas)) open(s, name);
    for (const [p, item] of Object.entries(doc.paths) as any) for (const [m, o] of Object.entries(item) as any) open(o.responses['200'], `${m} ${p}`);
    expect(doc.paths['/api/v1/transfers/proposals'].post.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
  });

  it('enumerations say whether new values may appear; the frozen ones are frozen for a reason', () => {
    for (const [name, e] of Object.entries(ENUMS)) {
      const s = doc.components.schemas[name];
      expect(s['x-spw-open'], name).toBe(e.open); expect(s['x-spw-values'], name).toEqual([...e.values]);
      if (e.open) expect(s.enum, `${name}: an open enumeration is not a JSON-Schema enum`).toBeUndefined(); else expect(s.enum, name).toEqual([...e.values]);
      expect(s.description.length, name).toBeGreaterThan(10);
    }
    expect(Object.entries(ENUMS).filter(([, e]) => !e.open).map(([n]) => n).sort()).toEqual(['AlertSeverity', 'Currency', 'FlowScope', 'ProposalState']);
    // the generated web types follow: an open enumeration accepts any string
    const ts = read('apps/web/src/generated/wallet-api.ts');
    expect(ts).toContain('export type Lifecycle = (typeof LIFECYCLE_VALUES)[number] | (string & {});');
    expect(ts).toContain('export type ProposalState = (typeof PROPOSAL_STATE_VALUES)[number];');
    expect(ts).toMatch(/export type Proposal = \{[\s\S]*?lifecycle: Lifecycle;[\s\S]*?\[extra: string\]: unknown;/);
  });
});

describe('the vocabularies are the code\'s own', () => {
  it('life cycle and stored states', () => {
    expect(ENUMS.Lifecycle.values).toEqual(LIFECYCLES);
    expect(Object.keys(ENUMS.Lifecycle.docs).sort()).toEqual([...LIFECYCLES].sort());
    expect(ENUMS.ProposalState.values).toEqual(STATES.filter((s) => s !== 'dropped'));
    // every stored state maps to a documented life-cycle value
    for (const s of STATES) for (const relayAttempted of [true, false]) for (const errorCode of [null, 'expired_onchain']) expect(LIFECYCLES).toContain(lifecycleOf(s, { relayAttempted, errorCode }));
    expect(doc['x-spw-lifecycle'].map((x: any) => x.lifecycle)).toEqual([...LIFECYCLES]);
  });
  it('proposal outcome codes are the outcome section of sv-texts.ts', () => {
    expect(PROPOSAL_OUTCOME_CODES).toEqual(Object.keys(SV).filter((k) => !k.startsWith('hold_') && !k.startsWith('plan_')));
    for (const c of ['dropped', 'relay_unconfirmed', 'expired_onchain', 'replaced_onchain', 'broadcast_disabled', 'rejected_by_owner', 'tx_failed']) expect(PROPOSAL_OUTCOME_CODES).toContain(c);
    // every code `failure(...)` is called with in the transfer path is documented
    const used = new Set([...(read('services/api/src/transfers.ts') + read('services/api/src/worker.ts')).matchAll(/failure\('([a-z_]+)'/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(8);
    for (const c of used) expect(PROPOSAL_OUTCOME_CODES, c).toContain(c);
  });
  it('transfer warnings: every code a chain adapter or the transfer route can emit is catalogued, and nothing marked emitted is not', () => {
    const src = [...filesOf(join(SRC, 'chains')), join(SRC, 'transfers.ts')].map((f: string) => readFileSync(f, 'utf8')).join('\n');
    const emitted = new Set([...src.matchAll(/\b(?:warnings|w)\.push\('([a-z0-9_]+)'/g)].map((m) => m[1]!));
    for (const m of src.matchAll(/\? \['([a-z_]+)'\] : \[\]/g)) emitted.add(m[1]!);                       // `duplicateWarning`, Cardano's locked outputs
    for (const m of src.matchAll(/\[\.\.\.warnings, '([a-z0-9_]+)'\]/g)) emitted.add(m[1]!);              // the OP-stack L1 fee
    // and, whatever the syntax: every snake_case literal on a line that builds warnings (`not_broadcast` is a state named on such a line)
    for (const line of src.split('\n')) if (/\bwarn(ings)?\b|\bw\.push/.test(line)) for (const m of line.matchAll(/'([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'/g)) if (m[1] !== 'not_broadcast') emitted.add(m[1]!);
    expect(emitted.size).toBeGreaterThan(10);
    expect([...emitted].sort()).toEqual(Object.entries(TRANSFER_WARNINGS).filter(([, w]) => w.emitted).map(([k]) => k).sort());
    for (const [code, w] of Object.entries(TRANSFER_WARNINGS)) if (!w.emitted) expect(src, `${code} is marked reserved but the code emits it: set emitted`).not.toContain(`'${code}'`);
    expect(Object.entries(TRANSFER_WARNINGS).filter(([, w]) => w.ack).map(([k]) => k)).toEqual(['new_destination', 'address_poisoning_suspected', 'duplicate_recent']);
    // the web app translates a warning as `w_<code>`: every emitted code has its string (the two NEXT added on the server included)
    const i18n = read('apps/web/src/i18n.ts');
    expect(Object.entries(TRANSFER_WARNINGS).filter(([code, w]) => w.emitted && !new RegExp(`^  w_${code}: \\[`, 'm').test(i18n)).map(([code]) => code)).toEqual([]);
  });
  it('event types are the ones the log receives', () => {
    for (const t of Object.keys(EVENT_TYPES)) expect(t.startsWith('transfer.') || MIRRORED.test(t), t).toBe(true);
    // the three written by the transfer path itself, and the mirrored audit types the wallet's own route files write
    const written = new Set([...(read('services/api/src/transfers.ts') + read('services/api/src/worker.ts')).matchAll(/walletEvent\('([a-z_.]+)'/g)].map((m) => m[1]!));
    expect([...written].sort()).toEqual(['transfer.confirmations', 'transfer.relay', 'transfer.state']);
    const audited = new Set<string>();
    for (const f of ['server.ts', 'auth.ts', 'prefs.ts', 'deposit-scan.ts']) for (const m of read(`services/api/src/${f}`).matchAll(/audit\('([a-z_.]+)'/g)) if (MIRRORED.test(m[1]!)) audited.add(m[1]!);
    for (const t of [...written, ...audited]) expect(Object.keys(EVENT_TYPES), t).toContain(t);
  });
  it('alert groups and severities', () => {
    expect([...new Set(ALERT_DEFS.map((d) => d.group))].sort()).toEqual([...ENUMS.AlertGroup.values].sort());
    expect([...new Set(ALERT_DEFS.map((d) => d.severity))].sort()).toEqual([...ENUMS.AlertSeverity.values].sort());
  });
});

describe('error catalogue', () => {
  it('every code an operation declares has a meaning and an action; nothing in the catalogue is unused', () => {
    const used = new Set(OPERATIONS.flatMap((o) => errorsOf(o).map((e) => e.code)));
    for (const c of used) { expect(WALLET_ERRORS[c], c).toBeTruthy(); expect(WALLET_ERRORS[c]![0].length, c).toBeGreaterThan(8); expect(WALLET_ERRORS[c]![1].length, c).toBeGreaterThan(4); }
    // catalogued without being an HTTP error of a wallet operation: answered by the gate in front of every route, or inside a dashboard section
    expect(Object.keys(WALLET_ERRORS).filter((c) => !used.has(c)).sort()).toEqual(['key_path_forbidden', 'timeout']);
    expect(Object.keys(doc['x-spw-error-catalog']).sort()).toEqual([...used].sort());
  });

  it('every `UserError` the wallet\'s route files throw is declared, with its status, by an operation of that file\'s family', () => {
    const declared = (tags: string[]): Set<string> => new Set(OPERATIONS.filter((o: WalletOp) => tags.includes(o.tag)).flatMap((o) => errorsOf(o).map((e) => `${e.status} ${e.code}`)));
    const all = declared(OPERATIONS.map((o) => o.tag));
    const files: [string, string[], string[]][] = [
      // file, the tags its routes carry, codes that never leave as an HTTP error of these routes (and why)
      ['transfers.ts', ['Transfers'], []],
      ['auth.ts', ['Auth', 'Security'], []],
      ['prefs.ts', ['Wallet', 'AddressBook'], []],
      ['events.ts', ['Events'], []],
      ['alerts/routes.ts', ['Alerts'], []],
      ['dashboard/activity.ts', ['Dashboard'], ['502 source_failed' /* caught: named in `errors` of the answer */]],
      ['dashboard/summary.ts', ['Dashboard'], ['504 timeout' /* caught: the section answers { ok: false } */]],
      ['dashboard/status.ts', ['Dashboard'], []],
      ['wallet-api/analytics.ts', ['Analytics'], []], ['wallet-api/search.ts', ['Search'], []],
    ];
    for (const [file, tags, internal] of files) {
      const ok = declared(tags);
      for (const [code, statuses] of userErrorsOf(read(`services/api/src/${file}`)) as Map<string, Set<number>>) for (const st of statuses) {
        const k = `${st} ${code}`;
        if (!internal.includes(k)) expect(ok.has(k), `${file} throws ${k}: declare it on an operation tagged ${tags.join(' / ')} in wallet-api/spec.ts`).toBe(true);
      }
    }
    // server.ts: its own routes and the gate (the other families' codes live in their own files)
    for (const [code, statuses] of userErrorsOf(read('services/api/src/server.ts')) as Map<string, Set<number>>) for (const st of statuses) expect(all.has(`${st} ${code}`), `server.ts throws ${st} ${code}`).toBe(true);
    // the chain adapters (prepare / build of a plain transfer): every code is one the two transfer operations declare
    const transfer = declared(['Transfers']);
    for (const [code, statuses] of scan([join(SRC, 'chains')]) as Map<string, Set<number>>) for (const st of statuses) expect(transfer.has(`${st} ${code}`), `a chain adapter throws ${st} ${code}: declare it (C.chain in wallet-api/spec.ts)`).toBe(true);
    // the signer client: unreachable, or the signer's own refusal passed through as `signer_<code>` (the operations that sign are marked open)
    expect([...(userErrorsOf(read('services/api/src/signer-client.ts')) as Map<string, Set<number>>).keys()].sort()).toEqual(['signer_unreachable', 'unsupported_network']);
    for (const id of ['createTransfer', 'requestApproval', 'approveTransfer', 'setupVerify', 'deviceConfirm', 'emergencyHalt']) expect(OPERATIONS.find((o) => o.id === id)!.errorsOpen, id).toBe(true);
  });

  it('the families documented elsewhere do not overlap the wallet contract', () => {
    for (const o of OPERATIONS) for (const p of Object.keys(OTHER_FAMILIES)) expect(o.path === p || o.path.startsWith(`${p}/`), `${o.id} under ${p}`).toBe(false);
    for (const p of Object.keys(OTHER_FAMILIES)) expect(p).toMatch(/^\/api\/v1\/[a-z-]+$/);
  });
});

describe('the validator of the contract test', () => {
  const proposal = { $ref: '#/components/schemas/Proposal' }, err = { $ref: '#/components/schemas/Error' };
  const good = { error: 'bad_request', message: 'invalid request', data: { fields: [{ path: 'a', code: 'too_small', message: 'x' }] } };
  it('accepts what conforms and names what does not', () => {
    expect(violations(doc, err, good, { strict: true })).toEqual([]);
    expect(violations(doc, err, { error: 'x' })).toEqual(['$.message: required']);
    expect(violations(doc, err, { ...good, message: 3 })).toEqual(['$.message: expected string, got 3']);
    expect(violations(doc, { $ref: '#/components/schemas/Nope' }, {})).toEqual(['$: unresolved #/components/schemas/Nope']);
    expect(violations(doc, proposal, {}).length).toBeGreaterThan(30);                                    // every member of the view is required
    expect(violations(doc, { $ref: '#/components/schemas/ProposalState' }, 'dropped')[0]).toMatch(/is not one of/);   // a frozen enumeration is closed
  });
  it('strict mode is what binds a descriptive contract: undeclared members and undocumented enumeration values fail', () => {
    expect(violations(doc, err, { ...good, hint: 'x' })).toEqual([]);                                     // on the wire the object is open…
    expect(violations(doc, err, { ...good, hint: 'x' }, { strict: true })).toEqual(['$.hint: returned by the server but not declared in the contract']);   // …the contract test is not
    expect(violations(doc, err, { ...good, data: { fields: [{ path: 'a', code: 'c', message: 'm', received: 'secret' }] } }, { strict: true })).toEqual(['$.data.fields[0].received: returned by the server but not declared in the contract']);
    const lc = { $ref: '#/components/schemas/Lifecycle' }, ec = { $ref: '#/components/schemas/ProposalErrorCode' };
    expect(violations(doc, lc, 'teleported')).toEqual([]);                                                // an open enumeration: any string is valid for a client
    expect(violations(doc, lc, 'teleported', { strict: true })).toEqual(['$: "teleported" is not a documented value of this enumeration']);
    expect(violations(doc, lc, 7, { strict: true })).toEqual(['$: expected string, got 7']);
    expect(violations(doc, ec, 'signer_unknown_credential', { strict: true })).toEqual([]);               // a documented family of codes
    expect(violations(doc, ec, 'made_up', { strict: true })).toHaveLength(1);
    // a free-form payload (no declared member) is not inspected; a map is validated value by value
    expect(violations(doc, { type: 'object', properties: {}, additionalProperties: {} }, { anything: 1 }, { strict: true })).toEqual([]);
    expect(violations(doc, { type: 'object', additionalProperties: { type: 'boolean' } }, { a: true, b: 'no' }, { strict: true })).toEqual(['$.b: expected boolean, got "no"']);
    expect(violations(doc, { anyOf: [{ type: 'string' }, { type: 'null' }] }, 3)[0]).toMatch(/matches no alternative/);
  });
});
