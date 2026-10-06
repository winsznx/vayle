// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ExternalReads} from "../libraries/ExternalReads.sol";
import {StockTokenRegistry} from "./StockTokenRegistry.sol";

/// @title PriceAdapter
/// @notice The reference price at a session close, in USDG base units per raw token, used only to
/// place strikes.
/// @dev The caller names a round, and the adapter proves it's the last round at or before the
/// close: the close has passed, the next round in the hint's phase landed after it, and no later
/// phase has a round at or before it. So the caller can't pick a convenient price. The feed
/// reports the price of one raw token with the token's multiplier already applied. No settlement
/// path reads this contract. Reads that fail revert ExternalReads.NotAStockToken or
/// ExternalReads.FeedUnusable.
contract PriceAdapter {
    uint256 public constant MAX_AGE_AT_CLOSE = 24 hours;
    uint256 private constant PHASE_SHIFT = 64;

    StockTokenRegistry public immutable registry;

    error CloseNotPassed(uint64 close, uint256 timestamp);
    error OraclePaused(address token);
    error FeedDecimalsChanged(address feed, uint8 listed, uint8 current);
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
        if (block.timestamp <= close) revert CloseNotPassed(close, block.timestamp);
        StockTokenRegistry.Asset memory asset = registry.asset(token);
        if (ExternalReads.oraclePaused(token)) revert OraclePaused(token);
        address feed = address(asset.feed);
        uint8 decimals = ExternalReads.feedDecimals(feed);
        if (decimals != asset.feedDecimals) {
            revert FeedDecimalsChanged(feed, asset.feedDecimals, decimals);
        }

        (bool exists, int256 answer, uint256 roundUpdatedAt) = ExternalReads.round(feed, roundHint);
        if (!exists) revert UnknownRound(roundHint);
        if (roundUpdatedAt > close) revert RoundAfterClose(roundHint, roundUpdatedAt, close);
        if (close - roundUpdatedAt > MAX_AGE_AT_CLOSE) {
            revert StaleAtClose(roundHint, roundUpdatedAt, close);
        }
        _requireLastRoundBy(feed, roundHint, close);
        if (answer <= 0) revert NonPositivePrice(roundHint, answer);

        uint256 scale = 10 ** (decimals - registry.usdgDecimals());
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

    /// @dev Round IDs are (phase << 64) | aggregator round, one phase per aggregator the proxy has
    /// pointed at. The hint's successor in its phase must have landed after the close. It may be
    /// missing only when the hint ends an older phase. The first round of every later phase must be
    /// missing or after the close. Rounds land in time order within a phase, so no round at or
    /// before the close is newer than the hint. Run with close < now, every future round lands
    /// after the close too.
    function _requireLastRoundBy(address feed, uint80 roundId, uint64 close) private view {
        uint80 latestId = ExternalReads.latestRoundId(feed);
        uint256 phase = uint256(roundId) >> PHASE_SHIFT;
        uint256 latestPhase = uint256(latestId) >> PHASE_SHIFT;
        if (phase > latestPhase) revert UnknownRound(roundId);
        if (roundId != latestId) {
            uint256 nextUpdatedAt = ExternalReads.roundUpdatedAt(feed, roundId + 1);
            bool provenLast = nextUpdatedAt != 0 ? nextUpdatedAt > close : phase < latestPhase;
            if (!provenLast) revert NotLastRoundBeforeClose(roundId, close);
        }
        for (uint256 later = phase + 1; later <= latestPhase; ++later) {
            // forge-lint: disable-next-line(unsafe-typecast) later fits the phase bits of a uint80
            uint80 firstOfPhase = uint80((later << PHASE_SHIFT) | 1);
            uint256 firstUpdatedAt = ExternalReads.roundUpdatedAt(feed, firstOfPhase);
            if (firstUpdatedAt != 0 && firstUpdatedAt <= close) {
                revert NotLastRoundBeforeClose(roundId, close);
            }
        }
    }
}
