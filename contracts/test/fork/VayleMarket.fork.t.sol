// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VayleMarket} from "../../src/VayleMarket.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {ChainActors, IOracleAdmin} from "../utils/ChainActors.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice The deployable market on real NVDA and USDG: roles, pauses, the emergency halt, launch
/// caps, and whole weeks end to end.
contract VayleMarketForkTest is VayleMarketFork {
    // Roles

    function test_theGuardianCantCallOwnerFunctions() public {
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        // #when
        vm.prank(guardian);
        market.setCaps(nvda, OptionType.Call, _pilotCaps());
    }

    function test_aMakerCantCallOwnerFunctions() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, quoter));
        // #when
        vm.prank(quoter);
        market.setTeamOperated(quoter, false);
    }

    function test_theOwnerCantPauseOrHalt() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.NotGuardian.selector, timelock));
        // #when
        vm.prank(timelock);
        market.halt();
    }

    function test_renouncingOwnershipIsDisabled() public {
        // #then
        vm.expectRevert(MarketGuard.RenounceDisabled.selector);
        // #when
        vm.prank(timelock);
        market.renounceOwnership();
    }

    function test_ownershipMovesOnlyWhenTheNewOwnerAccepts() public {
        // #given
        address next = makeAddr("nextTimelock");
        vm.prank(timelock);
        market.transferOwnership(next);
        // #when
        vm.prank(next);
        market.acceptOwnership();
        // #then
        assertEq(market.owner(), next);
    }

    function test_theOwnerReplacesTheGuardian() public {
        // #given
        address next = makeAddr("nextGuardian");
        // #when
        vm.prank(timelock);
        market.setGuardian(next);
        // #then
        assertEq(market.guardian(), next);
    }

    function test_theFeeStartsAtZero() public view {
        // #then
        assertEq(market.feeBps(), 0);
        assertEq(market.feeRecipient(), treasury);
    }

    // Pause

    function test_aPauseRefusesNewOrders() public {
        // #given
        vm.prank(guardian);
        market.setPaused(true);
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.MarketPaused.selector, nvda));
        // #when
        _place(alice, OptionType.Call, ONE);
    }

    function test_aPauseRefusesFills() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.prank(guardian);
        market.setPaused(true);
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.MarketPaused.selector, nvda));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_anAssetPauseRefusesThatAssetsOrders() public {
        // #given
        vm.prank(guardian);
        market.setAssetPaused(nvda, true);
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.MarketPaused.selector, nvda));
        // #when
        _place(alice, OptionType.Put, ONE);
    }

    function test_liftingAPauseReopensOrders() public {
        // #given
        vm.startPrank(guardian);
        market.setPaused(true);
        market.setPaused(false);
        vm.stopPrank();
        // #when
        uint256 id = _place(alice, OptionType.Call, ONE);
        // #then
        assertEq(market.orderOf(id).size, ONE);
    }

    function test_aPauseNeverBlocksExits() public {
        // #given: a written call, half of it uncommitted, then a pause
        uint256 id = _place(alice, OptionType.Call, 2 * ONE);
        _fillQuote(id, callSeries, ONE);
        vm.prank(guardian);
        market.setPaused(true);
        // #when: the holder cancels and withdraws, the maker exercises, the series settles
        vm.startPrank(alice);
        market.cancelOrder(id);
        market.withdraw(nvda, ONE);
        vm.stopPrank();
        _intoTheWindow();
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        _pastTheWindow();
        market.finalize(callSeries);
        market.settleOrder(id);
        uint256 proceeds = market.claimable(alice, usdg);
        vm.prank(alice);
        market.withdraw(usdg, proceeds);
        // #then
        assertEq(uint8(market.orderOf(id).status), uint8(CollateralVault.OrderStatus.Closed));
        _assertConserved(_claimants());
    }

    function test_anOraclePauseRefusesFills() public {
        // #given: the real pauser pauses NVDA's oracle
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.prank(ChainActors.ORACLE_PAUSER);
        IOracleAdmin(nvda).pauseOracle();
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.OraclePaused.selector, nvda));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    // Halt

    function test_aHaltRefusesEveryUserStateChange() public {
        // #given
        uint256 id = _writeCall(alice, ONE);
        uint256 open = _place(bob, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.warp(OCT_09 + 10 minutes);
        vm.prank(guardian);
        market.halt();
        bytes memory halted = abi.encodeWithSelector(
            MarketGuard.MarketHalted.selector, uint64(OCT_09 + 10 minutes + 72 hours)
        );
        CollateralVault.OrderParams memory p = _params(OptionType.Call, callStrike, ONE);
        // #then
        vm.expectRevert(halted);
        vm.prank(carol);
        market.placeOrder(p);
        vm.expectRevert(halted);
        vm.prank(bob);
        market.updateOrder(open, PRICE_TICK, false, 0);
        vm.expectRevert(halted);
        vm.prank(bob);
        market.cancelOrder(open);
        vm.expectRevert(halted);
        market.fillQuote(q, sig, open, ONE);
        vm.expectRevert(halted);
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        vm.expectRevert(halted);
        market.finalize(callSeries);
        vm.expectRevert(halted);
        market.settleOrder(id);
        vm.expectRevert(halted);
        vm.prank(alice);
        market.withdraw(usdg, PREMIUM);
        vm.expectRevert(halted);
        market.createEpoch(nvda, 1);
    }

    function test_haltedUntilReportsTheActiveHaltsEnd() public {
        // #given
        vm.prank(guardian);
        market.halt();
        uint64 end = uint64(vm.getBlockTimestamp() + 72 hours);
        // #when
        uint64 reported = market.haltedUntil();
        // #then
        assertEq(reported, end);
    }

    function test_haltedUntilIsZeroOnceTheHaltEnds() public {
        // #given
        vm.prank(guardian);
        market.halt();
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        // #when
        uint64 reported = market.haltedUntil();
        // #then
        assertEq(reported, 0);
    }

    function test_aHaltExpiresAfterSeventyTwoHours() public {
        // #given
        _writeCall(alice, ONE);
        vm.prank(guardian);
        market.halt();
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        // #when
        vm.prank(alice);
        market.withdraw(usdg, PREMIUM);
        // #then
        assertEq(market.claimable(alice, usdg), 0);
    }

    function test_theGuardianCantExtendAnActiveHalt() public {
        // #given
        vm.startPrank(guardian);
        market.halt();
        uint64 end = uint64(vm.getBlockTimestamp() + 72 hours);
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.AlreadyHalted.selector, end));
        // #when
        market.halt();
        vm.stopPrank();
    }

    function test_theGuardianWaitsSeventyTwoHoursAfterAHaltBeforeAnother() public {
        // #given
        vm.prank(guardian);
        market.halt();
        uint64 end = uint64(vm.getBlockTimestamp() + 72 hours);
        vm.warp(end + 72 hours - 1);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(MarketGuard.HaltCoolingDown.selector, end + 72 hours)
        );
        // #when
        vm.prank(guardian);
        market.halt();
    }

    function test_theGuardianCanHaltAgainOnceTheCooldownPasses() public {
        // #given
        vm.prank(guardian);
        market.halt();
        vm.warp(vm.getBlockTimestamp() + 144 hours);
        // #when
        vm.prank(guardian);
        market.halt();
        // #then
        assertEq(market.haltCount(), 2);
    }

    function test_theOwnerCanRenewAnActiveHalt() public {
        // #given
        vm.prank(guardian);
        market.halt();
        vm.warp(vm.getBlockTimestamp() + 70 hours);
        uint64 renewedEnd = uint64(vm.getBlockTimestamp() + 72 hours);
        // #when
        vm.prank(timelock);
        market.renewHalt();
        // #then
        vm.warp(renewedEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.MarketHalted.selector, renewedEnd));
        vm.prank(alice);
        market.withdraw(usdg, 0);
    }

    function test_theGuardianCanEndAHaltEarly() public {
        // #given
        vm.prank(guardian);
        market.halt();
        uint64 start = uint64(vm.getBlockTimestamp());
        vm.warp(start + 1 hours);
        // #when
        vm.prank(guardian);
        market.endHalt();
        // #then
        (uint64 haltStart, uint64 haltEnd) = market.haltAt(0);
        assertEq(haltStart, start);
        assertEq(haltEnd, start + 1 hours);
    }

    function test_endingAHaltWhenNoneIsActiveIsRefused() public {
        // #then
        vm.expectRevert(MarketGuard.NotHalted.selector);
        // #when
        vm.prank(guardian);
        market.endHalt();
    }

    function test_aHaltInTheWindowExtendsItByExactlyTheHaltedTime() public {
        // #given: a three-hour halt starting thirty minutes into the window
        _writeCall(alice, ONE);
        _keepAlive(OCT_09 - 5 minutes, OCT_09 + 30 minutes);
        vm.prank(guardian);
        market.halt();
        _keepAlive(OCT_09 + 31 minutes, OCT_09 + 3 hours + 30 minutes);
        vm.prank(guardian);
        market.endHalt();
        // #when
        uint64 end = market.windowEnd(callSeries);
        // #then
        assertEq(end, OCT_09 + 2 hours + 3 hours);
    }

    function test_theMakerCanStillExerciseInTheExtendedWindow() public {
        // #given
        _writeCall(alice, ONE);
        _keepAlive(OCT_09 - 5 minutes, OCT_09 + 30 minutes);
        vm.prank(guardian);
        market.halt();
        _keepAlive(OCT_09 + 31 minutes, OCT_09 + 3 hours + 30 minutes);
        vm.prank(guardian);
        market.endHalt();
        _keepAlive(OCT_09 + 3 hours + 31 minutes, OCT_09 + 5 hours - 1 minutes);
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        // #then
        assertEq(market.claimable(quoter, nvda), ONE);
    }

    // Caps

    function test_aPlacementOverTheOpenSizeCapIsRefused() public {
        // #given
        _place(alice, OptionType.Call, 4 * ONE);
        _place(bob, OptionType.Call, 4 * ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector, MarketGuard.Cap.OpenSize, 11 * ONE, 10 * ONE
            )
        );
        // #when
        _place(carol, OptionType.Call, 3 * ONE);
    }

    function test_aPlacementOverTheWalletCapIsRefused() public {
        // #given
        _place(alice, OptionType.Call, 4 * ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector, MarketGuard.Cap.WalletSize, 4 * ONE + LOT, 4 * ONE
            )
        );
        // #when
        _place(alice, OptionType.Call, LOT);
    }

    function test_aFillOverTheFillSizeCapIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, 3 * ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, 3 * ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector, MarketGuard.Cap.FillSize, 3 * ONE, 2 * ONE
            )
        );
        // #when
        market.fillQuote(q, sig, id, 3 * ONE);
    }

    function test_aFillOverTheSeriesOpenInterestCapIsRefused() public {
        // #given: six tokens written across three holders
        _writeCall(alice, 2 * ONE);
        _writeCall(bob, 2 * ONE);
        uint256 id = _place(carol, OptionType.Call, 3 * ONE);
        _fillQuote(id, callSeries, 2 * ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, LOT);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector,
                MarketGuard.Cap.SeriesOpenInterest,
                6 * ONE + LOT,
                6 * ONE
            )
        );
        // #when
        market.fillQuote(q, sig, id, LOT);
    }

    function test_aZeroCapKeepsASideClosed() public {
        // #given
        MarketGuard.Caps memory closed;
        vm.prank(timelock);
        market.setCaps(nvda, OptionType.Put, closed);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector, MarketGuard.Cap.OpenSize, LOT, 0
            )
        );
        // #when
        _place(alice, OptionType.Put, LOT);
    }

    function test_loweringCapsNeverTouchesALiveSeries() public {
        // #given: a written call, then every cap lowered to zero
        uint256 id = _writeCall(alice, ONE);
        MarketGuard.Caps memory closed;
        vm.prank(timelock);
        market.setCaps(nvda, OptionType.Call, closed);
        // #when
        _intoTheWindow();
        vm.prank(quoter);
        market.exercise(callSeries, ONE / 2);
        _pastTheWindow();
        market.finalize(callSeries);
        market.settleOrder(id);
        // #then
        assertEq(market.claimable(alice, usdg), PREMIUM + _value(ONE / 2, callStrike));
        _assertConserved(_claimants());
    }

    function test_cancellingFreesWalletRoom() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, 4 * ONE);
        vm.prank(alice);
        market.cancelOrder(id);
        // #when
        uint256 again = _place(alice, OptionType.Call, 4 * ONE);
        // #then
        assertEq(market.walletSize(alice, nvda, OptionType.Call), 4 * ONE);
        assertEq(market.orderOf(again).size, 4 * ONE);
    }

    function test_openSizeIsTheSumOfOrdersStillHoldingCollateral() public {
        // #given: one order written and settled with renewal, one cancelled while committed, one
        // left open
        uint256 renewing = _writeCall(alice, ONE);
        uint256 cancelled = _writeCall(bob, ONE);
        _place(carol, OptionType.Call, 2 * ONE);
        vm.prank(bob);
        market.cancelOrder(cancelled);
        _throughTheWindow();
        market.finalize(callSeries);
        // #when
        market.settleOrder(renewing);
        market.settleOrder(cancelled);
        // #then
        uint256 sum = market.orderOf(renewing).size + market.orderOf(cancelled).size + 2 * ONE;
        assertEq(market.openSize(nvda, OptionType.Call), sum);
        assertEq(sum, 3 * ONE);
    }

    // Whole weeks

    function test_aSellOrderRunsAWholeWeek() public {
        // #given: alice offers to sell one NVDA at the call target, and the maker buys the week
        uint256 id = _writeCall(alice, ONE);
        _intoTheWindow();
        // #when: NVDA ends above the target, the maker exercises, the series settles
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        _pastTheWindow();
        market.finalize(callSeries);
        market.settleOrder(id);
        vm.startPrank(alice);
        market.withdraw(usdg, market.claimable(alice, usdg));
        vm.stopPrank();
        // #then: alice sold at the target and kept the premium, and the order stopped
        assertEq(market.claimable(alice, usdg), 0);
        assertEq(uint8(market.orderOf(id).status), uint8(CollateralVault.OrderStatus.Closed));
        assertEq(market.claimable(quoter, nvda), ONE);
        _assertConserved(_claimants());
    }

    function test_aBuyOrderRunsAWholeWeekAndRenews() public {
        // #given: bob offers to buy one NVDA at the put target, and the maker buys the week
        uint256 id = _place(bob, OptionType.Put, ONE);
        _fillQuote(id, putSeries, ONE);
        _throughTheWindow();
        // #when: NVDA ends above the target, nobody exercises, the series settles
        market.finalize(putSeries);
        market.settleOrder(id);
        // #then: bob keeps the premium and his order stands for the next week
        assertEq(market.claimable(bob, usdg), PREMIUM);
        assertEq(market.orderOf(id).size, ONE);
        assertEq(uint8(market.orderOf(id).status), uint8(CollateralVault.OrderStatus.Active));
        _assertConserved(_claimants());
    }
}
