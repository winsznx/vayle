// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Functions of the Stock Token's oracle controls, called by their real role holder.
interface IOracleAdmin {
    function pauseOracle() external;
    function unpauseOracle() external;
}

/// @notice Real role holders on Robinhood Chain mainnet, impersonated in fork tests to call real
/// functions. Evidence links use the chain's block explorer as listed at
/// https://docs.robinhood.com/chain/connecting.
library ChainActors {
    /// @dev Called pauseOracle() on a Stock Token at block 978442:
    /// https://robinhoodchain.blockscout.com/tx/0x34f9aa77506ab96c5b8e3e5a9798ffab232533ae61759682c5b091ac4efb4a4f
    address internal constant ORACLE_PAUSER = 0x7369d100c00F28E45D779ac9d4b1c7afa61e4aBC;

    /// @dev Held about 24,527 raw NVDA and 52.2M USDG at block 81959622 (balanceOf reads,
    /// 2026-10-06). Fork tests fund test wallets by impersonating its transfers.
    /// https://robinhoodchain.blockscout.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951
    address internal constant FUNDING_SOURCE = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    error NoKnownHolder(string symbol);

    /// @notice A real holder of the Stock Token with this symbol, for funding test wallets.
    function holderOf(string memory symbol) internal pure returns (address) {
        bytes32 key = keccak256(bytes(symbol));
        if (key == keccak256("NVDA")) return FUNDING_SOURCE;
        revert NoKnownHolder(symbol);
    }

    /// @dev Called updateMultiplier(uint256,uint256) on NVDA at block 58952659:
    /// https://robinhoodchain.blockscout.com/tx/0x4ac23f2e58e2c4962dcd701c2beff581e87f3995152a29d527c07a3afd67d956
    address internal constant MULTIPLIER_UPDATER = 0x92905e8d0e2301BA143215B8D86D63fFD4188143;

    /// @dev Called pause() and unpause() on the Stock Tokens' shared access registry at blocks
    /// 611101 and 611243:
    /// https://robinhoodchain.blockscout.com/tx/0x04b200d0fc66e443d7f6765267a9c271cffc9f8d3fc7a2d48cbe9587123d6bd5
    address internal constant REGISTRY_PAUSER = 0xe7BCB188254Bc6eBBfF63014DfED4cD4A024F22A;

    /// @dev owner() of the NVDA/USD feed proxy at block 82002002 (2026-10-07), the only account
    /// that can propose and confirm the proxy's aggregator.
    /// https://robinhoodchain.blockscout.com/address/0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
    address internal constant FEED_PROXY_OWNER = 0xeE27D5Ae494300902D90454e8630A3F1C68c9C52;
}
