// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// FORK ONLY — used by scripts/fork-gmx.mts and by nothing else. Stand-in for GMX's ChainlinkDataStreamProvider
/// (0x7BA7Ae61887F1aca28E0FE5aB1434ce85b6606aa on Arbitrum One): its runtime bytecode is written over that address ON A
/// LOCAL ANVIL FORK with anvil_setCode, so that an impersonated real order keeper can execute an order with a price the
/// script chooses. It has the deployed provider's interface (IOracleProvider, 7-field ValidatedPrice) and verifies NO
/// signature: a real keeper must present a Chainlink Data Streams report that the real provider verifies on-chain.
/// Compiled with solc 0.8.29, optimizer 200 runs, no metadata; the bytecode is embedded in scripts/fork-gmx.mts.
contract GmxMockOracleProvider {
    struct ValidatedPrice { address token; uint256 min; uint256 max; uint256 rawMin; uint256 rawMax; uint256 timestamp; address provider; }

    function getOraclePrice(address token, bytes memory data) external view returns (ValidatedPrice memory) {
        (uint256 min, uint256 max) = abi.decode(data, (uint256, uint256));
        return ValidatedPrice(token, min, max, min, max, block.timestamp, address(this));
    }
    function shouldAdjustTimestamp() external pure returns (bool) { return false; }
    function isChainlinkOnChainProvider() external pure returns (bool) { return false; }
    function shouldCheckRefPrice() external pure returns (bool) { return false; }
}
