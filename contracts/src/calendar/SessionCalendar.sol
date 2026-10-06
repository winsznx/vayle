// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SessionRules} from "../libraries/SessionRules.sol";

/// @title SessionCalendar
/// @notice The schedule of weekly boundary closes that epochs expire at.
/// @dev Owned by the timelocked admin, which appends closes computed offchain from the exchange's
/// published calendar. An epoch copies its expiry when it's created, so editing the schedule can
/// never move a live epoch. Only closes more than MIN_LEAD in the future can be added or removed.
contract SessionCalendar is Ownable2Step {
    uint256 public constant MIN_LEAD = 1 days;

    uint64[] private _closes;

    event ClosesAppended(uint256 indexed fromIndex, uint64[] closes);
    event ClosesTruncated(uint256 indexed keep, uint256 removed);

    error NotASessionClose(uint64 close);
    error NotIncreasing(uint64 previous, uint64 close);
    error TooSoon(uint64 close, uint256 earliest);
    error NothingToTruncate(uint256 keep, uint256 length);
    error NoCloseAfter(uint64 timestamp);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function append(uint64[] calldata closes) external onlyOwner {
        uint256 fromIndex = _closes.length;
        uint256 earliest = block.timestamp + MIN_LEAD;
        uint64 previous = fromIndex == 0 ? 0 : _closes[fromIndex - 1];
        for (uint256 i; i < closes.length; ++i) {
            uint64 close = closes[i];
            if (!SessionRules.isSessionClose(close)) revert NotASessionClose(close);
            if (close <= previous) revert NotIncreasing(previous, close);
            if (close <= earliest) revert TooSoon(close, earliest);
            _closes.push(close);
            previous = close;
        }
        emit ClosesAppended(fromIndex, closes);
    }

    /// @notice Removes every close from index `keep` on. Each removed close must still be more than
    /// MIN_LEAD away.
    function truncate(uint256 keep) external onlyOwner {
        uint256 length = _closes.length;
        if (keep >= length) revert NothingToTruncate(keep, length);
        uint256 earliest = block.timestamp + MIN_LEAD;
        if (_closes[keep] <= earliest) revert TooSoon(_closes[keep], earliest);
        for (uint256 i = length; i > keep; --i) {
            _closes.pop();
        }
        emit ClosesTruncated(keep, length - keep);
    }

    function closeCount() external view returns (uint256) {
        return _closes.length;
    }

    function closeAt(uint256 index) external view returns (uint64) {
        return _closes[index];
    }

    /// @notice The first scheduled close strictly after `timestamp`.
    function nextCloseAfter(uint64 timestamp) external view returns (uint64) {
        uint256 lo = 0;
        uint256 hi = _closes.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_closes[mid] <= timestamp) lo = mid + 1;
            else hi = mid;
        }
        if (lo == _closes.length) revert NoCloseAfter(timestamp);
        return _closes[lo];
    }
}
