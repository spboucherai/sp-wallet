# SP Wallet NEXT — deployment

Nothing in this document has been executed on production. Every stage needs the owner's explicit go-ahead; stages 3 and 5
change the signer and need it separately.

## 1. Environments

| Environment | What it is | Used for |
|---|---|---|
| Development | laptop worktree, per-run test databases (`services/api/test/test-db.ts`), throwaway signer, scripted chains | unit, integration and contract tests |
| Fork / dev stack | `scripts/dev-stack.sh` and `SPWalletCore/Scripts/dev-stack.sh`: local API + throwaway signer, broadcast off or a local anvil fork with fake funds | browser and native end-to-end runs, the macOS self-test |
| **Pre-production rehearsal** | `scripts/rehearse-next.mts`: the NEXT server on a **restored copy of the production database**, read-only against the real chains, with a stub signer that answers status and nothing else (no key exists in the process, broadcast off, no agent / venue / alert worker) | migration on real data, real-chain reads, timings |
| Production | M2M32c (API, web, Postgres), m6ma (signer), BHS64 (gateway) | — |

There is no permanent staging host: a second signer with real keys must not exist, and a staging stack with other keys
would read other addresses. The rehearsal gives the part that matters — real data, real networks — without a key.

**Rehearsal results (2026-11-19, dump of 03:20):** migration 1.2 s, idempotent; proposals and audit chain byte-identical;
one-in-flight index created; 21 deposits classified (16 external, 5 internal); every new route answered 200; the signer
stub received only `GET /status`. Findings fixed before release: 19 s cold portfolio read, 88 s deposit scan, value
snapshots made unusable by one unreadable network, Litecoin balance unavailable when one of its two sources is down.

## 2. Order of release (progressive)

| Stage | What | Depends on | Reversible by |
|---|---|---|---|
| 0 | Backups: new `scripts/backup.sh` + `scripts/restore-test.sh` on M2M32c; off-node copy (`SPW_BACKUP_REMOTE`) | owner: destination node | restoring the old script |
| 1 | Rehearsal on the dump of the day | — | — |
| 2 | **API + web** (`next` → `main`) on M2M32c | stage 1 green | `git checkout` previous commit + rebuild + restart; the schema is additive (see §5) |
| 3 | **Signer bundle** on m6ma (review list S1–S12, `SP-WALLET-SECURITY.md`) | owner's approval of the list; same window as stage 2 or right after | previous `signer.mjs` (see §5) |
| 4 | Watch 24 h (§6) | — | — |
| 5 | Optional policy keys on the signer: passkey cool-down, vault-return cap | owner's values | removing the keys |
| 6 | macOS build (notarised) and iOS build (TestFlight) | stages 2–3 live (the apps need the new routes; they degrade when a route is missing) | previous builds keep working: the API is additive |

Between stages 2 and 3 everything works except adding or revoking a passkey (the new API asks the signer for a route the
old signer does not have: an error, nothing is added). Native apps 1.0 keep working after stage 3 except "add a passkey"
(they fail locally, before any prompt) until stage 6.

## 3. Stage 2 — API and web

On the laptop: `git push origin next:main` (after the owner's go-ahead). On M2M32c, in `~/apps/sp-wallet`:

```
scripts/backup.sh && scripts/restore-test.sh              # a dump that restores, taken now
pg_dump -Fc "$DATABASE_URL" > ~/backups/sp-wallet/pre-next-$(date +%Y%m%d-%H%M).dump
tar czf ~/backups/sp-wallet/dist-pre-next-$(date +%Y%m%d-%H%M).tgz dist
git pull --ff-only && pnpm install --frozen-lockfile
node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)   # never restart before the web build ends
# restart keeping the whole PM2 environment (re-export it from `pm2 jlist`, then):
pm2 restart sp-wallet --update-env
```

New optional environment: `SPW_BACKUP_REMOTE` (backup job), `SPW_COMMIT` is not needed (the build reads git).
Nothing existing is renamed. The migration runs at start (1.2 s on the rehearsal).

Checks right after: `/api/v1/health/live` 200; start-up capability line unchanged; `GET /api/v1/openapi.json` (session)
answers; the worker loops `reconcile`, `deposits`, `balances`, `snapshots`, `events-prune` report in « État du système »;
one `portfolio_snapshots` row within 10 minutes; no `proposals_one_in_flight not created` warning in the log.

## 4. Stage 3 — signer

Pre-checks on m6ma: `pm2 env` shows `SPW_SIGNER_ALLOW_IPS` set (the new binary refuses to start otherwise);
no transfer in flight (`select count(*) from proposals where state in ('approved','signed','broadcast')` = 0);
no quoting mandate active.

```
cd ~/apps/sp-wallet-signer && cp signer.mjs signer.mjs.bak-next
cp ~/sp-wallet-signer-data/state.json ~/sp-wallet-signer-data/state.json.bak-next      # for inspection only: never restore it (§5)
cp ~/sp-wallet-signer-data/policy.json ~/sp-wallet-signer-data/policy.json.bak-next
# from the laptop: scp dist/signer.mjs m6ma:apps/sp-wallet-signer/      (policy.json is NOT deleted, NOT edited)
pm2 restart sp-wallet-signer && node signer.mjs status          # key id must stay spw-ab7cac49ffebb919
```

Checks: the start line shows `allowed-sources=<API node>`; the web Security Center lists the passkey from the signer with
no mismatch; `node signer.mjs backup-state ~/signer-state-$(date +%Y%m%d).tar` works (copy it off the node).
Then, with the owner at the keyboard: `node signer.mjs verify-recovery` (checks the paper phrase without showing anything).

## 5. Rollback

**API / web.** `git checkout <previous commit>`, rebuild, restart. The schema changes are additive (new columns, tables and
one partial unique index); the previous code runs on the new schema. Two things the previous code does not know:
- rows in state `dropped`: the old state machine has no such state. Before rolling back:
  `update proposals set state = 'failed' where state = 'dropped'` (they read as failed in the old vocabulary anyway);
- `replaced` rows are final again for the old code (no re-check): nothing to do.

**Signer.** Put `signer.mjs.bak-next` back and restart. First remove `newCredentialCooldownSec` / `maxVaultReturnsPerDay`
from `policy.json` if stage 5 added them (the old binary refuses unknown keys). **Never restore `state.json.bak-next`**: it
would bring back passkeys revoked since. The old binary ignores the new state fields.

**Database.** Restoring the pre-release dump is the last resort (it loses what happened since): only on the owner's
decision, with the signer halted.

**Triggers for a rollback:** a transfer shown in a state the chain contradicts; the signer refusing valid approvals; a
worker loop failing repeatedly; the audit chain reported broken.

## 6. Monitoring after release

- « État du système » (`/monitor`): worker loops, endpoint health, signer reachable.
- New alerts: `transfer.dropped`, `transfer.replaced`, `transfer.expired`, `transfer.recovered` (critical),
  `security.credential_mismatch` (critical), `security.passkey_revoked`.
- Logs on M2M32c: `[worker] reconcile …` lines; `native <network>: scan bound reached` is normal on busy addresses.
- Daily: `scripts/restore-test.sh` on the night's dump (to be scheduled with the backup job).

## 7. First real operations (owner)

A simulated or fork test is not proof on a real chain. After release, in this order, each for a small amount:
1. a send on Base, then on **Arbitrum in ETH** (the gas-limit fix, never exercised on the real network);
2. a receive in native coin on an EVM network (detection is new);
3. add a second passkey from the web, see it in the Security Center, revoke it;
4. open the macOS and iOS apps: the dashboard matches the web figure for figure; a send made on one appears on the others
   without reloading.

## 8. Not part of this release

APNs push (owner decision), intentional replacement of a stuck transaction (new signing rule), restore of a signer from
the phrase (`import-recovery`), disk encryption / firewall changes on m6ma (owner decision).
