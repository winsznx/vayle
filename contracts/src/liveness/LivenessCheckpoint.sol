// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title LivenessCheckpoint
/// @notice Records when the chain went quiet, so settlement windows can be extended by time
/// nobody could transact.
/// @dev This chain has no sequencer uptime feed. Every Vayle state change calls checkpoint(), and
/// a keeper calls it every minute around each close and exercise window. Any stretch longer than
/// GAP_THRESHOLD with no checkpoint is recorded as a gap. A missing keeper also opens a gap, which
/// only ever lengthens a window. Anyone can call checkpoint() to close a gap that isn't an outage.
contract LivenessCheckpoint {
    uint64 public constant GAP_THRESHOLD = 5 minutes;

    struct Gap {
        uint64 start;
        uint64 end;
    }

    uint64 public lastSeen;
    Gap[] private _gaps;

    event GapRecorded(uint256 indexed index, uint64 start, uint64 end);

    function checkpoint() external {
        uint64 now_ = uint64(block.timestamp);
        uint64 previous = lastSeen;
        if (previous != 0 && now_ - previous > GAP_THRESHOLD) {
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

    /// @notice Total seconds of recorded gaps that fall inside [from, to].
    function gapOverlap(uint64 from, uint64 to) external view returns (uint64 total) {
        if (to <= from) return 0;
        uint256 length = _gaps.length;
        uint256 lo = 0;
        uint256 hi = length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_gaps[mid].end <= from) lo = mid + 1;
            else hi = mid;
        }
        for (uint256 i = lo; i < length; ++i) {
            Gap memory gap = _gaps[i];
            if (gap.start >= to) break;
            uint64 start = gap.start > from ? gap.start : from;
            uint64 end = gap.end < to ? gap.end : to;
            total += end - start;
        }
    }
}
