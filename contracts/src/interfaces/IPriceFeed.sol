// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice The Chainlink aggregator proxy functions Vayle reads.
/// @dev Proxy round IDs pack the phase in the top bits: (phaseId << 64) | aggregatorRoundId.
interface IPriceFeed {
    function decimals() external view returns (uint8);

    function getRoundData(uint80 roundId)
        external
        view
        returns (
            uint80 id,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function latestRoundData()
        external
        view
        returns (
            uint80 id,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
