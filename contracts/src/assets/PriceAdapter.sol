// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPriceFeed} from "../interfaces/IPriceFeed.sol";
import {IStockToken} from "../interfaces/IStockToken.sol";
import {StockTokenRegistry} from "./StockTokenRegistry.sol";

/// @title PriceAdapter
/// @notice The reference price at a session close, in USDG base units per raw token, used only to
/// place strikes.
/// @dev The caller names a round, and the adapter proves it's the last round at or before the
/// close by checking that the next round, if any, landed after the close. The caller can't pick a
/// convenient price. The feed reports the price of one raw token with the token's multiplier
/// already applied. No settlement path reads this contract.
contract PriceAdapter {
    uint256 public constant MAX_AGE_AT_CLOSE = 24 hours;

    StockTokenRegistry public immutable registry;

    error OraclePaused(address token);
    error UnknownRound(uint80 roundId);
    error RoundAfterClose(uint80 roundId, uint256 updatedAt, uint64 close);
    error StaleAtClose(uint80 roundId, uint256 updatedAt, uint64 close);
    error NotLastRoundBeforeClose(uint80 roundId, uint64 close);
    error NonPositivePrice(uint80 roundId, int256 answer);
    error PriceJump(uint256 price, uint256 previousReference);

    constructor(StockTokenRegistry registry_) {
        registry = registry_;
    }

    /// @param roundHint The feed's last round at or before `close`, found offchain.
    /// @param previousReference The previous epoch's reference price, or 0 for the first epoch.
    function referencePrice(
        address token,
        uint64 close,
        uint80 roundHint,
        uint256 previousReference
    ) external view returns (uint256 price, uint80 roundId, uint64 updatedAt) {
        StockTokenRegistry.Asset memory asset = registry.asset(token);
        if (IStockToken(token).oraclePaused()) revert OraclePaused(token);

        (bool exists, int256 answer, uint256 roundUpdatedAt) = _round(asset.feed, roundHint);
        if (!exists) revert UnknownRound(roundHint);
        if (roundUpdatedAt > close) revert RoundAfterClose(roundHint, roundUpdatedAt, close);
        if (close - roundUpdatedAt > MAX_AGE_AT_CLOSE) {
            revert StaleAtClose(roundHint, roundUpdatedAt, close);
        }
        _requireNoLaterRoundBy(asset.feed, roundHint, close);
        if (answer <= 0) revert NonPositivePrice(roundHint, answer);

        uint256 scale = 10 ** (asset.feedDecimals - registry.usdgDecimals());
        uint256 raw = SafeCast.toUint256(answer);
        price = raw / scale;
        if (
            previousReference != 0
                && (raw * 2 < previousReference * scale || raw * 2 > previousReference * scale * 3)
        ) {
            revert PriceJump(price, previousReference);
        }
        return (price, roundHint, SafeCast.toUint64(roundUpdatedAt));
    }

    /// @dev The round after `roundId` is the next ID in the same phase, or the first round of the
    /// next phase when the aggregator changed. When `roundId` is the latest round there's none.
    function _requireNoLaterRoundBy(IPriceFeed feed, uint80 roundId, uint64 close) private view {
        // slither-disable-next-line unused-return
        (uint80 latestId,,,,) = feed.latestRoundData(); // only the latest round ID matters here
        if (roundId == latestId) return;
        (bool exists,, uint256 nextUpdatedAt) = _round(feed, roundId + 1);
        if (!exists) {
            uint80 nextPhaseFirst = uint80((((uint256(roundId) >> 64) + 1) << 64) | 1);
            (exists,, nextUpdatedAt) = _round(feed, nextPhaseFirst);
            if (!exists) revert NotLastRoundBeforeClose(roundId, close);
        }
        if (nextUpdatedAt <= close) revert NotLastRoundBeforeClose(roundId, close);
    }

    function _round(IPriceFeed feed, uint80 roundId)
        private
        view
        returns (bool exists, int256 answer, uint256 updatedAt)
    {
        // slither-disable-next-line unused-return
        try feed.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            return (u != 0, a, u);
        } catch {
            return (false, 0, 0);
        }
    }
}
