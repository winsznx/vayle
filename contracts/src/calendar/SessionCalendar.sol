// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SessionRules} from "../libraries/SessionRules.sol";

/// @title SessionCalendar
/// @notice The schedule of weekly boundary closes that epochs open and expire at, each with the
/// deadline for opening an epoch at it.
/// @dev Owned by the timelocked admin, which appends boundaries computed offchain from the
/// exchange's published calendar. An epoch copies its expiry when it's created, so editing the
/// schedule can never move a live epoch. Only closes more than MIN_LEAD in the future can be added
/// or removed, and the next close after now can't be removed at all, since it's the expiry of the
/// live or about-to-open epoch. The schedule passed at deployment only needs closes in the future,
/// since no order exists yet that a close at short notice could surprise.
contract SessionCalendar is Ownable2Step {
    uint256 public constant MIN_LEAD = 1 days;
    uint256 public constant MAX_SPACING = 15 days;
    uint256 public constant MAX_CREATION_DELAY = 7 days;

    /// @param creationDeadline The Monday 09:30 ET after the close. An epoch opening at this
    /// close can be created until then.
    struct Boundary {
        uint64 close;
        uint64 creationDeadline;
    }

    Boundary[] private _boundaries;

    event BoundariesAppended(uint256 indexed fromIndex, Boundary[] boundaries);
    event BoundariesTruncated(uint256 indexed keep, uint256 removed);

    error NotASessionClose(uint64 close);
    error NotIncreasing(uint64 previous, uint64 close);
    error TooSoon(uint64 close, uint256 earliest);
    error TooFarApart(uint64 previous, uint64 close);
    error BadCreationDeadline(uint64 close, uint64 creationDeadline);
    error NothingToTruncate(uint256 keep, uint256 length);
    error ProtectedClose(uint64 close);
    error NoCloseAfter(uint64 timestamp);
    error NoCloseAtOrBefore(uint64 timestamp);

    constructor(address initialOwner, Boundary[] memory initial) Ownable(initialOwner) {
        _append(initial, block.timestamp);
    }

    function append(Boundary[] calldata boundaries) external onlyOwner {
        _append(boundaries, block.timestamp + MIN_LEAD);
    }

    /// @notice Removes every boundary from index `keep` on. The next close after now stays, and
    /// each removed close must still be more than MIN_LEAD away.
    function truncate(uint256 keep) external onlyOwner {
        uint256 length = _boundaries.length;
        if (keep >= length) revert NothingToTruncate(keep, length);
        uint64 first = _boundaries[keep].close;
        if (keep <= _firstAfter(uint64(block.timestamp))) revert ProtectedClose(first);
        uint256 earliest = block.timestamp + MIN_LEAD;
        if (first <= earliest) revert TooSoon(first, earliest);
        for (uint256 i = length; i > keep; --i) {
            _boundaries.pop();
        }
        emit BoundariesTruncated(keep, length - keep);
    }

    function boundaryCount() external view returns (uint256) {
        return _boundaries.length;
    }

    function boundaryAt(uint256 index) external view returns (Boundary memory) {
        return _boundaries[index];
    }

    /// @notice The last scheduled boundary whose close is at or before `timestamp`.
    function latestBoundaryAtOrBefore(uint64 timestamp) external view returns (Boundary memory) {
        uint256 index = _firstAfter(timestamp);
        if (index == 0) revert NoCloseAtOrBefore(timestamp);
        return _boundaries[index - 1];
    }

    /// @notice The first scheduled close strictly after `timestamp`.
    function nextCloseAfter(uint64 timestamp) external view returns (uint64) {
        uint256 index = _firstAfter(timestamp);
        if (index == _boundaries.length) revert NoCloseAfter(timestamp);
        return _boundaries[index].close;
    }

    function _append(Boundary[] memory boundaries, uint256 earliest) private {
        uint256 fromIndex = _boundaries.length;
        Boundary memory previous = fromIndex == 0 ? Boundary(0, 0) : _boundaries[fromIndex - 1];
        for (uint256 i; i < boundaries.length; ++i) {
            Boundary memory next = boundaries[i];
            _checkNext(previous, next, earliest);
            _boundaries.push(next);
            previous = next;
        }
        emit BoundariesAppended(fromIndex, boundaries);
    }

    /// @dev The spacing cap only binds while an epoch could still open at the previous boundary,
    /// so a schedule that ran out can always be restarted.
    function _checkNext(Boundary memory previous, Boundary memory next, uint256 earliest)
        private
        view
    {
        uint64 close = next.close;
        if (!SessionRules.isSessionClose(close)) revert NotASessionClose(close);
        if (close <= previous.close) revert NotIncreasing(previous.close, close);
        if (close <= earliest) revert TooSoon(close, earliest);
        if (previous.creationDeadline > block.timestamp && close - previous.close > MAX_SPACING) {
            revert TooFarApart(previous.close, close);
        }
        uint64 deadline = next.creationDeadline;
        if (
            !SessionRules.isMondayOpen(deadline) || deadline <= close
                || deadline - close >= MAX_CREATION_DELAY
        ) {
            revert BadCreationDeadline(close, deadline);
        }
    }

    /// @dev Index of the first close strictly after `timestamp`, or the length if there's none.
    function _firstAfter(uint64 timestamp) private view returns (uint256) {
        uint256 lo = 0;
        uint256 hi = _boundaries.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_boundaries[mid].close <= timestamp) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
}
