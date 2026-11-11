// Maya Protocol (MAYAChain) native cross-chain swaps — price discovery only (docs/swap/providers/maya.md).
// MAYAChain is a THORChain fork: same quote endpoint shape, same 1e8 fixed point, same memo grammar. The engine lives in
// thorchain.ts; this file holds what differs, verified live on 2026-11-10 against MAYANode 1.135.4:
//  - endpoints under /mayachain, errors answered as HTTP 200 `{ "error": … }`
//  - its own pools (BTC, ETH, Arbitrum for the chains the wallet has; DASH, ZEC, ADA, RUNE, CACAO have no wallet network)
//  - streaming swaps exist only when asked for (no advanced swap queue): every quote asks for `streaming_interval=3&streaming_quantity=0`
//  - the memo limit is checked against the swap output BEFORE the outbound fee (x/mayachain/swap_current.go), while the
//    quote derives it from the amount AFTER that fee: the recipient's real floor is limit − outbound fee, and that is what
//    this adapter reports as `minAmountOut`.
import type { SwapProvider } from '../types.ts';
import type { ProviderEnv } from './index.ts';
import { createNativeSwapProvider, type NativeSwapConfig } from './thorchain.ts';

/** Public MAYANode listed by the official docs (https://docs.mayaprotocol.com/mayachain-dev-docs/concepts/connecting-to-mayachain). */
export const MAYA_API = 'https://mayanode.mayachain.info/mayachain';
export const MAYA_API_VERSION = '1.135.4'; // /mayachain/version on 2026-11-10
/** Blocks between sub-swaps requested for every quote (the value used in the protocol's own streaming examples is a free choice; 3 ≈ 18 s). */
export const MAYA_STREAMING_INTERVAL = 3;

export const MAYA_CONFIG: NativeSwapConfig = {
  id: 'maya', name: 'Maya Protocol', docs: 'https://docs.mayaprotocol.com/mayachain-dev-docs/introduction/swapping-guide/quickstart-guide', api: MAYA_API,
  chains: { BTC: 'bitcoin', ETH: 'ethereum', ARB: 'arbitrum' },
  // GET /mayachain/pools on 2026-11-10, status "Available", on a chain the wallet has. Staged pools (ETH.PEPE, ARB.ARB, ARB.DAI…) are not listed.
  pools: [
    'BTC.BTC', 'ETH.ETH', 'ARB.ETH',
    'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7',
    'ARB.USDC-0XAF88D065E77C8CC2239327C5EDB3A432268E5831', 'ARB.USDT-0XFD086BC7CD5C481DCC9C85EBE478A1C0B69FCBB9',
    'ARB.WBTC-0X2F2A2543B76A4166549F7AAB2E75BEF0AEFC5B0F',
  ],
  // short codes MAYANode writes in quote memos (observed live; common/asset.go)
  shortCodes: { b: 'BTC.BTC', e: 'ETH.ETH', a: 'ARB.ETH' },
  // `router` in GET /mayachain/inbound_addresses, identical on mayanode.mayachain.info and api-maya.liquify.com on 2026-11-10
  routers: {
    ethereum: '0xe3985E6b61b814F7Cdb188766562ba71b446B46d',
    arbitrum: '0x700E97ef07219440487840Dc472E7120A7FF11F4',
  },
  streaming: { interval: MAYA_STREAMING_INTERVAL },
  limitIsNetOfOutboundFee: false,
};

export function createMayaProvider(_env: ProviderEnv = {}): SwapProvider {
  return createNativeSwapProvider(MAYA_CONFIG);
}
