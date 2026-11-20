# Runbooks

## Where things run
- `sp-wallet` (API + web, Postgres db `sp_wallet`): see `mld status`. Dir `~/apps/sp-wallet`, PM2 `sp-wallet`, nightly `sp-wallet-backup`.
- `sp-wallet-signer`: dedicated node. Dir `~/apps/sp-wallet-signer` (bundle only), data `~/sp-wallet-signer-data`
  (keystore, state, policy), wrap key `~/.config/sp-wallet-signer/wrap.key`, PM2 `sp-wallet-signer`, port 8651 (LAN, API node IP only).
- The API reaches the signer by LAN IP written at deploy time. After a DHCP renumbering: `mld deploy sp-wallet-signer && mld deploy sp-wallet`.

## Emergency halt
Phone: Security → Emergency halt → type STOP. Or on the signer node: `node ~/apps/sp-wallet-signer/signer.mjs halt`.
Resume, on the signer node only: `node ~/apps/sp-wallet-signer/signer.mjs unhalt`. Balances stay visible while halted.

Since V11 no restart is needed and none should be chained: the command is applied by the running daemon itself (it answers
`applied by the running daemon: in force now`) through a socket in the signer's data directory, so the daemon's next save
cannot undo it. When no daemon runs, the command writes the state file under a lock (`no daemon is running: written to the
state file`). If it answers that the state is in use but the control socket did not answer, nothing was changed: check the
daemon (`pm2 logs sp-wallet-signer`) before trying again. The same holds for `reset-passkeys` and `setup-token`.

Since NEXT the halt never waits: from the app or from the command line it is applied the moment the signer has
authenticated the request, also while a signature is being computed or the signer is waiting for a price. A signature that
was being computed at that moment is not released (the app shows the operation as refused; the signer's journal records
`halt.withheld`); the proposal it belonged to is spent and must be made again once the halt is lifted. `unhalt` still waits
for the request in progress to finish.

What the halt stops: transfers, swaps, bridges, deposits, withdrawals from a venue, new positions, orders that can add
exposure, leverage changes, new authorizations and mandates. What it never stops (V11): cancelling an order, closing or
reducing a position (Hyperliquid reduce-only orders, GMX decreases and cancellations — the passkey is still asked where it
was before), and bringing agent-vault funds back to your own address.

## Paper backup of the recovery phrase (do this first)
In your own Terminal (not through an assistant, no screen sharing): `ssh -t <signer-node> /opt/homebrew/bin/node apps/sp-wallet-signer/signer.mjs export-recovery`,
type `SHOW`, write the 24 words on paper, clear the terminal. The phrase restores all three chains in any BIP-39 wallet
(paths in `docs/adr/0001-custody.md`).

Since NEXT the signer records WHEN the phrase was displayed (journal `recovery.exported`; `recoveryExportedAt` in its
status and in Security — `null` means never). To check that what is on paper is right, without displaying anything:
`ssh -t <signer-node> /opt/homebrew/bin/node apps/sp-wallet-signer/signer.mjs verify-recovery`, type the 24 words (nothing
is echoed), Enter. The only answers are `matches this signer's key` / `does not match this signer's key`; a match is
recorded (`recoveryVerifiedAt`). Like `export-recovery` it runs in an interactive terminal only — never piped, never over
the API, never by an assistant.

## Restore on a new signer node
There is deliberately no import command yet. Quickest safe path: import the 24 words into a standard wallet app
(EVM `m/44'/60'/0'/0/0`, BTC BIP-84 account 0, Solana `m/44'/501'/0'/0'`) and move the funds; then deploy a fresh signer
(`init`), run owner setup again and deposit to the new addresses.

## Revoking one passkey (NEXT)
In the app: Security → the passkey → revoke, approved with ANOTHER enrolled passkey (the signer verifies it; the last
passkey cannot be revoked; allowed under the emergency halt). Its sessions end. A passkey listed as "signer only" (pinned on
the signer, unknown to the app — an alert is raised when that lasts) is revoked the same way. If no other passkey is left to
approve, use "Lost passkey" below.

## Lost passkey
On the signer node: `signer.mjs reset-passkeys`, `signer.mjs setup-token` (applied by the running daemon: no restart); on the API node
`psql sp_wallet -c 'delete from credentials; update sessions set revoked = true'`; open the site and run setup again.

## Changing limits
Edit `~/sp-wallet-signer-data/policy.json` on the signer node (base units; increment `version`), `pm2 restart sp-wallet-signer`.

## After a release that adds assets (registry v5: policy version 3)
The signer writes its default limits only when `policy.json` does not exist, so limits for new assets do not appear by themselves:
a token without a limit cannot be sent or swapped (default deny). On the signer node, either move the file aside and restart
(`mv policy.json policy.json.v2 && pm2 restart sp-wallet-signer` — the signer regenerates it from the defaults of the release,
`version: 3`; re-apply any limit you had changed by hand), or add the new `"<network>:<symbol>"` keys to `perTx` and `daily`
yourself and set `version` to 3. Existing limits are unchanged in the defaults. See `docs/TOKENS.md`.

## After the release that adds Cardano and Polkadot (policy version 4)
Same rule as above: an existing `policy.json` does not gain the new entries by itself. Either regenerate it from the defaults
(`mv policy.json policy.json.v3 && pm2 restart sp-wallet-signer`, then re-apply hand-made changes), or add by hand
`"cardano:ADA": "285000000"` / `"polkadot:DOT": "600000000000"` to `perTx`, twice those values to `daily`,
`"cardano": "500000"` / `"polkadot": "500000000"` to `maxFee`, and set `version` to 4. No existing limit changes.
The two new addresses appear after the signer restarts (same seed; the wallet key id does not change).
If Polkadot sends stop with `runtime_changed`, or Cardano sends with `protocol_changed`: `docs/chains/polkadot.md`
("Runtime upgrades") and `docs/chains/cardano.md` ("Data sources and agreement").

## Compromise suspected
Halt, then sweep funds to a new wallet from a clean device using the recovery phrase. Treat the old keys as burned.

## Health
`https://wallet.spboucher.ai/api/v1/health/live` (public, no detail). Detail (authenticated): Settings → RPC status, Security.

## Signer relay (API node)
macOS denies local-network access to PM2 / LaunchAgent background processes (EHOSTUNREACH), so the API talks to
`127.0.0.1:8652`, a byte relay run as a root LaunchDaemon (`ai.spboucher.sp-wallet-signer-relay`, script copied to
`/usr/local/libexec/sp-wallet/signer-relay.mjs`, root-owned) that forwards to `m6ma.local:8651` (mDNS, survives DHCP changes).
Reinstall on a new API node: copy `scripts/signer-relay.mjs` there as root, install `infra/launchd/*.plist` in
`/Library/LaunchDaemons`, `sudo launchctl bootstrap system <plist>`. Log: `~/Library/Logs/sp-wallet-signer-relay.log`.
The signer allowlist must contain the API node LAN IP (`SPW_SIGNER_ALLOW_IPS`, rendered at deploy).
