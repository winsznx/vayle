// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Real role holders on Robinhood Chain mainnet, impersonated in fork tests to call real
/// functions.
library ChainActors {
    /// @dev Called pauseOracle() on a Stock Token in tx
    /// 0x34f9aa77506ab96c5b8e3e5a9798ffab232533ae61759682c5b091ac4efb4a4f, block 978442.
    address internal constant ORACLE_PAUSER = 0x7369d100c00F28E45D779ac9d4b1c7afa61e4aBC;

    /// @dev Held about 24,527 raw NVDA and 52.2M USDG at block 81959622 (balanceOf reads,
    /// 2026-10-06). Fork tests fund test wallets by impersonating its transfers.
    address internal constant FUNDING_SOURCE = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /// @dev Called updateMultiplier(uint256,uint256) on NVDA in tx
    /// 0x4ac23f2e58e2c4962dcd701c2beff581e87f3995152a29d527c07a3afd67d956, block 58952659.
    address internal constant MULTIPLIER_UPDATER = 0x92905e8d0e2301BA143215B8D86D63fFD4188143;

    /// @dev Called pause() and unpause() on the Stock Tokens' shared access registry in txs
    /// 0x04b200d0fc66e443d7f6765267a9c271cffc9f8d3fc7a2d48cbe9587123d6bd5 (block 611101) and
    /// at block 611243.
    address internal constant REGISTRY_PAUSER = 0xe7BCB188254Bc6eBBfF63014DfED4cD4A024F22A;
}
