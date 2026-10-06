// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";

contract LivenessCheckpointTest is Test {
    uint64 internal constant START = 1_791_576_000;

    LivenessCheckpoint internal liveness;

    event GapRecorded(uint256 indexed index, uint64 start, uint64 end);

    function setUp() public {
        vm.warp(START);
        liveness = new LivenessCheckpoint();
    }

    function _checkpointAt(uint256 timestamp) internal {
        vm.warp(timestamp);
        liveness.checkpoint();
    }

    function test_deploymentCountsAsTheFirstCheckpoint() public view {
        // #then
        assertEq(liveness.lastSeen(), START);
    }

    function test_silenceBetweenDeploymentAndTheFirstPingIsAGap() public {
        // #given
        uint64 firstPing = START + 20 minutes;
        // #then
        vm.expectEmit(address(liveness));
        emit GapRecorded(0, START, firstPing);
        // #when
        _checkpointAt(firstPing);
    }

    function test_aFirstPingSoonAfterDeploymentRecordsNoGap() public {
        // #when
        _checkpointAt(START + liveness.GAP_THRESHOLD());
        // #then
        assertEq(liveness.gapCount(), 0);
    }

    function test_recordsAQuietStretchLongerThanTheThreshold() public {
        // #given
        _checkpointAt(START);
        uint64 later = START + 20 minutes;
        // #then
        vm.expectEmit(address(liveness));
        emit GapRecorded(0, START, later);
        // #when
        _checkpointAt(later);
        // #then
        LivenessCheckpoint.Gap memory gap = liveness.gapAt(0);
        assertEq(gap.start, START);
        assertEq(gap.end, later);
    }

    function test_ignoresAQuietStretchOfExactlyTheThreshold() public {
        // #given
        _checkpointAt(START);
        // #when
        _checkpointAt(START + liveness.GAP_THRESHOLD());
        // #then
        assertEq(liveness.gapCount(), 0);
    }

    function test_overlapIsZeroForAnEmptyOrInvertedInterval() public {
        // #given
        _checkpointAt(START);
        _checkpointAt(START + 1 hours);
        // #then
        assertEq(liveness.gapOverlap(START + 10, START + 10), 0);
        assertEq(liveness.gapOverlap(START + 20, START + 10), 0);
    }

    function testFuzz_overlapMatchesANaiveSum(uint64[8] memory steps, uint64 from, uint64 to)
        public
    {
        // #given: checkpoints at increasing times, some far enough apart to leave gaps
        uint256 t = START;
        _checkpointAt(t);
        for (uint256 i; i < steps.length; ++i) {
            t += bound(steps[i], 1, 2 hours);
            _checkpointAt(t);
        }
        from = uint64(bound(from, START - 1 hours, t + 1 hours));
        to = uint64(bound(to, START - 1 hours, t + 1 hours));
        uint64 expected;
        if (to > from) {
            for (uint256 i; i < liveness.gapCount(); ++i) {
                LivenessCheckpoint.Gap memory gap = liveness.gapAt(i);
                uint64 start = gap.start > from ? gap.start : from;
                uint64 end = gap.end < to ? gap.end : to;
                if (end > start) expected += end - start;
            }
        }
        // #when
        uint64 overlap = liveness.gapOverlap(from, to);
        // #then
        assertEq(overlap, expected);
    }
}
