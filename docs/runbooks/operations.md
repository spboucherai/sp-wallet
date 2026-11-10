# Runbooks

## Where things run
- `sp-wallet` (API + web, Postgres db `sp_wallet`): see `mld status`. Dir `~/apps/sp-wallet`, PM2 `sp-wallet`, nightly `sp-wallet-backup`.
- `sp-wallet-signer`: dedicated node. Dir `~/apps/sp-wallet-signer` (bundle only), data `~/sp-wallet-signer-data`
  (keystore, state, policy), wrap key `~/.config/sp-wallet-signer/wrap.key`, PM2 `sp-wallet-signer`, port 8651 (LAN, API node IP only).
- The API reaches the signer by LAN IP written at deploy time. After a DHCP renumbering: `mld deploy sp-wallet-signer && mld deploy sp-wallet`.

## Emergency halt
Phone: Security → Emergency halt → type STOP. Or on the signer node: `node ~/apps/sp-wallet-signer/signer.mjs halt && pm2 restart sp-wallet-signer`.
Resume: `node ~/apps/sp-wallet-signer/signer.mjs unhalt && pm2 restart sp-wallet-signer`. Balances stay visible while halted.

## Paper backup of the recovery phrase (do this first)
In your own Terminal (not through an assistant, no screen sharing): `ssh -t <signer-node> /opt/homebrew/bin/node apps/sp-wallet-signer/signer.mjs export-recovery`,
type `SHOW`, write the 24 words on paper, clear the terminal. The phrase restores all three chains in any BIP-39 wallet
(paths in `docs/adr/0001-custody.md`).

## Restore on a new signer node
There is deliberately no import command yet. Quickest safe path: import the 24 words into a standard wallet app
(EVM `m/44'/60'/0'/0/0`, BTC BIP-84 account 0, Solana `m/44'/501'/0'/0'`) and move the funds; then deploy a fresh signer
(`init`), run owner setup again and deposit to the new addresses.

## Lost passkey
On the signer node: `signer.mjs reset-passkeys`, `signer.mjs setup-token`, restart the signer; on the API node
`psql sp_wallet -c 'delete from credentials; update sessions set revoked = true'`; open the site and run setup again.

## Changing limits
Edit `~/sp-wallet-signer-data/policy.json` on the signer node (base units; increment `version`), `pm2 restart sp-wallet-signer`.

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
