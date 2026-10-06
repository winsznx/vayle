// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";
import {IStockToken} from "../interfaces/IStockToken.sol";

/// @title ExternalReads
/// @notice Reads from Stock Tokens and price feeds that fail with a named error instead of a bare
/// revert.
/// @dev Each read is a staticcall that requires the exact reply length, because try/catch can't
/// catch a reply that fails to decode. Values are range-checked before they're narrowed.
library ExternalReads {
    uint256 private constant WORD = 32;
    uint256 private constant ROUND_REPLY = 5 * WORD;

    error NotAStockToken(address token);
    error FeedUnusable(address feed);

    function tokenDecimals(address token) internal view returns (uint8) {
        (bool ok, uint256 value) = _word(token, abi.encodeCall(IStockToken.decimals, ()));
        if (!ok || value > type(uint8).max) revert NotAStockToken(token);
        // forge-lint: disable-next-line(unsafe-typecast) range-checked above
        return uint8(value);
    }

    function oraclePaused(address token) internal view returns (bool) {
        return _oracleFlag(token) == 1;
    }

    /// @dev For listing, where the flag only has to be readable.
    function requireOracleFlag(address token) internal view {
        _oracleFlag(token);
    }

    function feedDecimals(address feed) internal view returns (uint8) {
        (bool ok, uint256 value) = _word(feed, abi.encodeCall(IPriceFeed.decimals, ()));
        if (!ok || value > type(uint8).max) revert FeedUnusable(feed);
        // forge-lint: disable-next-line(unsafe-typecast) range-checked above
        return uint8(value);
    }

    /// @dev Staleness doesn't apply: only the ID is used, to bound the successor proof.
    // slither-disable-next-line oracle-no-staleness
    function latestRoundId(address feed) internal view returns (uint80) {
        uint256 id = abi.decode(_latestRoundData(feed), (uint256));
        if (id > type(uint80).max) revert FeedUnusable(feed);
        // forge-lint: disable-next-line(unsafe-typecast) range-checked above
        return uint80(id);
    }

    /// @dev For listing, which only checks that the feed answers. The price adapter checks the age
    /// of the round it uses against each close.
    // slither-disable-next-line oracle-no-staleness
    function latestAnswer(address feed) internal view returns (int256 answer) {
        (, answer) = abi.decode(_latestRoundData(feed), (uint256, int256));
    }

    /// @return exists False when the feed reverts, answers in the wrong shape, or has no data for
    /// the round.
    function round(address feed, uint80 roundId)
        internal
        view
        returns (bool exists, int256 answer, uint256 updatedAt)
    {
        bytes memory reply = _roundData(feed, roundId);
        if (reply.length == 0) return (false, 0, 0);
        (, answer,, updatedAt,) = abi.decode(reply, (uint256, int256, uint256, uint256, uint256));
        exists = updatedAt != 0;
    }

    /// @return updatedAt When the round landed, or 0 when the feed doesn't have it.
    function roundUpdatedAt(address feed, uint80 roundId)
        internal
        view
        returns (uint256 updatedAt)
    {
        bytes memory reply = _roundData(feed, roundId);
        if (reply.length == 0) return 0;
        (,,, updatedAt,) = abi.decode(reply, (uint256, int256, uint256, uint256, uint256));
    }

    function _oracleFlag(address token) private view returns (uint256 value) {
        bool ok;
        (ok, value) = _word(token, abi.encodeCall(IStockToken.oraclePaused, ()));
        if (!ok || value > 1) revert NotAStockToken(token);
    }

    // slither-disable-next-line oracle-no-staleness
    function _latestRoundData(address feed) private view returns (bytes memory reply) {
        bool ok;
        (ok, reply) = feed.staticcall(abi.encodeCall(IPriceFeed.latestRoundData, ()));
        if (!ok || reply.length != ROUND_REPLY) revert FeedUnusable(feed);
    }

    /// @dev The reply, or empty when the call fails or the reply has the wrong length.
    function _roundData(address feed, uint80 roundId) private view returns (bytes memory) {
        (bool ok, bytes memory reply) =
            feed.staticcall(abi.encodeCall(IPriceFeed.getRoundData, (roundId)));
        return ok && reply.length == ROUND_REPLY ? reply : new bytes(0);
    }

    function _word(address target, bytes memory data)
        private
        view
        returns (bool ok, uint256 value)
    {
        (bool success, bytes memory reply) = target.staticcall(data);
        if (!success || reply.length != WORD) return (false, 0);
        return (true, abi.decode(reply, (uint256)));
    }
}
