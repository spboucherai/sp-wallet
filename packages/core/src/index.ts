/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/index.ts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

export * from './tokens.ts';
export * from './networks.ts';
export * from './amounts.ts';
export * from './address.ts';
export * from './intent.ts';
export * from './build-evm.ts';
export * from './swap-evm.ts';
export * from './cctp.ts';
export * from './cctp-sol.ts'; // v8 Solana ↔ EVM CCTP
export * from './cctp-sol-tx.ts'; // v8 Solana ↔ EVM CCTP
export * from './thorchain.ts';
export * from './mandate.ts';
export * from './market-listings.ts';
export * from './market-symbols.ts';
export * from './build-btc.ts';
export * from './build-sol.ts';
export * from './swap-sol.ts';
export * from './policy.ts';
export * from './audit.ts';
export * from './state.ts';
export * from './families.ts';
export * from './plugins/index.ts';
export * from './alert-catalog.ts';
export * from './research-job.ts'; // v7 research runtime
export * from './research-sandbox.ts'; // v7 research runtime
export * from './nft-intent.ts'; // NFT delivery 2
export * from './nft-evm.ts'; // NFT delivery 2
export * from './nft-sol.ts'; // NFT delivery 2
export * from './nft-policy.ts'; // NFT delivery 2
export * from './credential.ts'; // NEXT: credential life cycle v2 (SPW-CRED-v2)
