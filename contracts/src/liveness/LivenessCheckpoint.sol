// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title LivenessCheckpoint
/// @notice Records when the chain went quiet, so settlement windows can be extended by time
/// nobody could transact.
/// @dev This chain has no sequencer uptime feed. Every Vayle state change calls checkpoint(), and
/// a keeper calls it every minute from 45 minutes before each close and through each exercise
/// window. Any stretch longer than GAP_THRESHOLD with no checkpoint is recorded as a gap, from the
/// last checkpoint to the call that ends it, and a recorded gap is permanent. Deployment counts as
/// the first checkpoint, so silence before the first ping is a gap too. A missing keeper only ever
/// refuses an epoch or lengthens a window. Anyone can call checkpoint().
contract LivenessCheckpoint {
    uint64 public constant GAP_THRESHOLD = 5 minutes;

    struct Gap {
        uint64 start;
        uint64 end;
    }

    uint64 public lastSeen;
    Gap[] private _gaps;

    event GapRecorded(uint256 indexed index, uint64 start, uint64 end);

    constructor() {
        lastSeen = uint64(block.timestamp);
    }

    function checkpoint() external {
        uint64 now_ = uint64(block.timestamp);
        uint64 previous = lastSeen;
        if (now_ - previous > GAP_THRESHOLD) {
            _gaps.push(Gap({start: previous, end: now_}));
            emit GapRecorded(_gaps.length - 1, previous, now_);
        }
        if (now_ != previous) lastSeen = now_;
    }

    function gapCount() external view returns (uint256) {
        return _gaps.length;
    }

    function gapAt(uint256 index) external view returns (Gap memory) {
        return _gaps[index];
    }

    /// @notice Index of the first recorded gap that ends after `timestamp`, or gapCount() if none.
    function firstGapEndingAfter(uint64 timestamp) public view returns (uint256 index) {
        uint256 hi = _gaps.length;
        while (index < hi) {
            uint256 mid = (index + hi) / 2;
            if (_gaps[mid].end <= timestamp) index = mid + 1;
            else hi = mid;
        }
    }

    /// @notice Total seconds of recorded gaps that fall inside [from, to].
    function gapOverlap(uint64 from, uint64 to) external view returns (uint64 total) {
        if (to <= from) return 0;
        uint256 length = _gaps.length;
        for (uint256 i = firstGapEndingAfter(from); i < length; ++i) {
            Gap memory gap = _gaps[i];
            if (gap.start >= to) break;
            uint64 start = gap.start > from ? gap.start : from;
            uint64 end = gap.end < to ? gap.end : to;
            total += end - start;
        }
    }
}
