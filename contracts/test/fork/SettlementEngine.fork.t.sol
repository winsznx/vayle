// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {SettlementEngine} from "../../src/core/SettlementEngine.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";
import {SettlementHarness} from "../core/SettlementHarness.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {CoreFork} from "../utils/VaultFork.sol";

interface IPausableRegistry {
    function pause() external;
    function unpause() external;
}

contract SettlementEngineForkTest is CoreFork {
    uint256 internal constant ONE = 1e18;

    SettlementHarness internal engine;

    function _deployCore() internal override returns (CollateralVault) {
        engine = new SettlementHarness(calendar, registry, adapter, liveness);
        return engine;
    }

    /// @dev The keeper pinging liveness and pause observation every minute.
    function _keep(uint256 from, uint256 to) internal {
        for (uint256 t = from; t <= to; t += 1 minutes) {
            vm.warp(t);
            liveness.checkpoint();
            engine.observePauses(stock);
        }
    }

    function _writeCall(uint256 size) internal returns (uint256 id) {
        id = _place(alice, OptionType.Call, size);
        _fill(id, callSeries, size);
    }

    function _writePut(uint256 size) internal returns (uint256 id) {
        id = _place(bob, OptionType.Put, size);
        _fill(id, putSeries, size);
    }

    function test_exerciseBeforeExpiryIsRefused() public {
        // #given
        _writeCall(ONE);
        vm.warp(OCT_09 - 1);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEngine.WindowNotOpen.selector, callSeries, OCT_09)
        );
        // #when
        vm.prank(maker);
        engine.exercise(callSeries, lot);
    }

    function test_aCallExercisedInTheWindowPaysTheStrikeAndCreditsTheAsset() public {
        // #given
        _writeCall(ONE);
        _keep(OCT_09 - 10 minutes, OCT_09 + 5 minutes);
        uint256 usdgBefore = IERC20(usdg).balanceOf(maker);
        // #when
        vm.prank(maker);
        engine.exercise(callSeries, ONE / 2);
        // #then
        assertEq(IERC20(usdg).balanceOf(maker), usdgBefore - _value(ONE / 2, callStrike));
        assertEq(engine.claimable(maker, stock), ONE / 2);
        assertEq(engine.balanceOf(maker, callSeries), ONE / 2);
        _assertConserved(_everyone());
    }

    function test_aPutExercisedInTheWindowTakesTheAssetAndCreditsTheStrike() public {
        // #given
        _writePut(ONE);
        _keep(OCT_09 - 10 minutes, OCT_09 + 5 minutes);
        uint256 stockBefore = IERC20(stock).balanceOf(maker);
        // #when
        vm.prank(maker);
        engine.exercise(putSeries, ONE);
        // #then
        assertEq(IERC20(stock).balanceOf(maker), stockBefore - ONE);
        assertEq(engine.claimable(maker, usdg), _value(ONE, putStrike));
        _assertConserved(_everyone());
    }

    function test_exerciseAfterTheWindowIsRefused() public {
        // #given
        _writeCall(ONE);
        _keep(OCT_09 - 10 minutes, OCT_09 + 2 hours + 1 minutes);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEngine.WindowClosed.selector, callSeries, OCT_09 + 2 hours
            )
        );
        // #when
        vm.prank(maker);
        engine.exercise(callSeries, lot);
    }

    function test_finalizeWaitsForTheWindowAndAnyoneMayCallIt() public {
        // #given
        uint256 id = _writeCall(ONE);
        _keep(OCT_09 - 10 minutes, OCT_09 + 1 hours);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEngine.WindowStillOpen.selector, callSeries, OCT_09 + 2 hours
            )
        );
        // #when
        engine.finalize(callSeries);
        // #given
        _keep(OCT_09 + 1 hours + 1 minutes, OCT_09 + 2 hours);
        // #when
        vm.prank(makeAddr("anyone"));
        engine.finalize(callSeries);
        engine.settleOrder(id);
        // #then
        assertTrue(engine.poolOf(callSeries).settled);
        assertEq(engine.orderOf(id).size, ONE);
        _assertConserved(_everyone());
    }

    function test_aQuietStretchInsideTheWindowExtendsIt() public {
        // #given: the keeper stops 30 minutes into the window and the chain is silent for 2 hours
        _writeCall(ONE);
        _keep(OCT_09 - 10 minutes, OCT_09 + 30 minutes);
        vm.warp(OCT_09 + 2 hours + 30 minutes);
        // #when: the first call after the silence records the gap and still gets in
        vm.prank(maker);
        engine.exercise(callSeries, lot);
        // #then
        assertEq(engine.windowEnd(callSeries), OCT_09 + 4 hours);
        assertEq(engine.claimable(maker, stock), lot);
    }

    function test_theLivenessExtensionIsCappedAtADay() public {
        // #given
        _writeCall(ONE);
        _keep(OCT_09 - 10 minutes, OCT_09 + 30 minutes);
        vm.warp(OCT_09 + 5 days);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEngine.WindowClosed.selector, callSeries, OCT_09 + 2 hours + 24 hours
            )
        );
        // #when
        vm.prank(maker);
        engine.exercise(callSeries, lot);
    }

    function test_anIssuerPauseInsideTheWindowExtendsItByThePausedTime() public {
        // #given: the issuer pauses every Stock Token an hour into the window, for four hours
        _writePut(ONE);
        _keep(OCT_09 - 10 minutes, OCT_09 + 1 hours);
        vm.prank(ChainActors.REGISTRY_PAUSER);
        IPausableRegistry(stockAccessRegistry).pause();
        _keep(OCT_09 + 1 hours + 1 minutes, OCT_09 + 3 hours);
        // #then: delivering the asset fails while it's paused
        vm.expectRevert();
        vm.prank(maker);
        engine.exercise(putSeries, lot);
        // #given
        _keep(OCT_09 + 3 hours + 1 minutes, OCT_09 + 5 hours);
        vm.prank(ChainActors.REGISTRY_PAUSER);
        IPausableRegistry(stockAccessRegistry).unpause();
        _keep(OCT_09 + 5 hours + 1 minutes, OCT_09 + 5 hours + 30 minutes);
        // #when: after the pause, the window has grown by about the four paused hours
        vm.prank(maker);
        engine.exercise(putSeries, lot);
        // #then
        assertGe(engine.windowEnd(putSeries), OCT_09 + 6 hours);
        assertLe(engine.windowEnd(putSeries), OCT_09 + 6 hours + 2 minutes);
        assertEq(engine.claimable(maker, usdg), _value(lot, putStrike));
    }

    function test_observingPausesOnAnAssetWithoutFlagsIsHarmless() public {
        // #when
        engine.observePauses(usdg);
        // #then
        assertEq(engine.pauseCount(usdg), 0);
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_windowEndMatchesAMinuteByMinuteWalk(uint16[10] memory pauses) public {
        // #given: checkpoints on whole minutes with random silences around the window
        _writeCall(ONE);
        uint256 t = OCT_09 - 10 minutes;
        vm.warp(t);
        liveness.checkpoint();
        for (uint256 i; i < pauses.length; ++i) {
            t += bound(pauses[i], 1, 600) * 1 minutes;
            vm.warp(t);
            liveness.checkpoint();
        }
        // #when
        uint64 end = engine.windowEnd(callSeries);
        // #then: walk the window a minute at a time, spending gap minutes from the budget
        uint256 minute = OCT_09;
        uint256 remaining = 2 hours;
        uint256 budget = 24 hours;
        while (remaining > 0) {
            if (budget > 0 && _insideGap(minute)) budget -= 1 minutes;
            else remaining -= 1 minutes;
            minute += 1 minutes;
        }
        assertEq(end, minute);
    }

    function _insideGap(uint256 instant) internal view returns (bool) {
        for (uint256 i; i < liveness.gapCount(); ++i) {
            LivenessCheckpoint.Gap memory gap = liveness.gapAt(i);
            if (instant >= gap.start && instant < gap.end) return true;
        }
        return false;
    }
}
