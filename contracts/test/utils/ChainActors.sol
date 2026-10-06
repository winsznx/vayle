// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Real role holders on Robinhood Chain mainnet, impersonated in fork tests to call real
/// functions.
library ChainActors {
    /// @dev Called pauseOracle() on a Stock Token in tx
    /// 0x34f9aa77506ab96c5b8e3e5a9798ffab232533ae61759682c5b091ac4efb4a4f, block 978442.
    address internal constant ORACLE_PAUSER = 0x7369d100c00F28E45D779ac9d4b1c7afa61e4aBC;
}
