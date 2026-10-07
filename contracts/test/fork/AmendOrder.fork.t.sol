// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {RenewalBatch} from "../../src/core/RenewalBatch.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice The deployable market with helpers for amending orders.
abstract contract AmendOrderFork is VayleMarketFork {
    /// @dev The least premium _params places at.
    function _floor() internal view returns (uint256) {
        return priceTick * 10;
    }

    function _placeAt(address owner, OptionType side, uint256 target, uint256 size)
        internal
        returns (uint256 id)
    {
        vm.prank(owner);
        id = market.placeOrder(_params(side, target, size));
    }

    /// @dev New terms with the floor _params places at and flip off.
    function _terms(uint256 target, uint256 size)
        internal
        view
        returns (CollateralVault.AmendParams memory)
    {
        return CollateralVault.AmendParams({
            target: target, minPremium: _floor(), size: size, flip: false, flipTarget: 0
        });
    }

    function _amend(address owner, uint256 id, CollateralVault.AmendParams memory p) internal {
        vm.prank(owner);
        market.amendOrder(id, p);
    }

    function _credits(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(market)
                    && logs[i].topics[0] == CollateralVault.Credited.selector
            ) {
                ++n;
            }
        }
    }
}

/// @notice Amending an idle order's price and size: the order keeps its ID and moves bucket, only
/// the collateral difference moves, and every placement rule still applies.
contract AmendOrderForkTest is AmendOrderFork {
    // Price and size

    function test_raisingABuyOrdersPricePullsOnlyTheExtraUsdg() public {
        // #given: bob bids for one NVDA a tick under the put strike
        uint256 id = _placeAt(bob, OptionType.Put, putStrike - strikeTick, ONE);
        uint256 extra = _value(ONE, putStrike) - _value(ONE, putStrike - strikeTick);
        uint256 before = IERC20(usdg).balanceOf(bob);
        // #then
        vm.expectCall(usdg, abi.encodeCall(IERC20.transferFrom, (bob, address(market), extra)), 1);
        // #when
        vm.recordLogs();
        _amend(bob, id, _terms(putStrike, ONE));
        // #then
        assertEq(before - IERC20(usdg).balanceOf(bob), extra);
        assertEq(_credits(vm.getRecordedLogs()), 0);
        assertEq(market.claimable(bob, usdg), 0);
        assertEq(market.orderOf(id).target, putStrike);
        _assertConserved(_claimants());
    }

    function test_loweringABuyOrdersPriceReleasesTheDifferenceToClaimable() public {
        // #given
        uint256 id = _placeAt(bob, OptionType.Put, putStrike, ONE);
        uint256 freed = _value(ONE, putStrike) - _value(ONE, putStrike - strikeTick);
        uint256 before = IERC20(usdg).balanceOf(bob);
        // #then
        vm.expectCall(usdg, abi.encodeWithSelector(IERC20.transferFrom.selector), 0);
        // #when
        _amend(bob, id, _terms(putStrike - strikeTick, ONE));
        // #then
        assertEq(market.claimable(bob, usdg), freed);
        assertEq(IERC20(usdg).balanceOf(bob), before);
        _assertConserved(_claimants());
    }

    function test_raisingASellOrdersPriceMovesNoCollateral() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        uint256 before = IERC20(stock).balanceOf(alice);
        // #then
        vm.expectCall(stock, abi.encodeWithSelector(IERC20.transferFrom.selector), 0);
        // #when
        vm.recordLogs();
        _amend(alice, id, _terms(callStrike + strikeTick, ONE));
        // #then: the raw tokens backing a sell order don't depend on its price
        assertEq(_credits(vm.getRecordedLogs()), 0);
        assertEq(IERC20(stock).balanceOf(alice), before);
        assertEq(market.claimable(alice, stock), 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike + strikeTick), ONE);
        _assertConserved(_claimants());
    }

    function test_loweringASellOrdersPriceMovesNoCollateral() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike + strikeTick, ONE);
        // #then
        vm.expectCall(stock, abi.encodeWithSelector(IERC20.transferFrom.selector), 0);
        // #when
        _amend(alice, id, _terms(callStrike, ONE));
        // #then
        assertEq(market.claimable(alice, stock), 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike + strikeTick), 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), ONE);
        _assertConserved(_claimants());
    }

    function test_growingASellOrderPullsOnlyTheExtraTokens() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        uint256 before = IERC20(stock).balanceOf(alice);
        // #then
        vm.expectCall(stock, abi.encodeCall(IERC20.transferFrom, (alice, address(market), ONE)), 1);
        // #when
        _amend(alice, id, _terms(callStrike, 2 * ONE));
        // #then
        assertEq(before - IERC20(stock).balanceOf(alice), ONE);
        assertEq(market.orderOf(id).size, 2 * ONE);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), 2 * ONE);
        _assertConserved(_claimants());
    }

    function test_shrinkingASellOrderReleasesTheDifferenceToClaimable() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, 3 * ONE);
        uint256 before = IERC20(stock).balanceOf(alice);
        // #then
        vm.expectCall(stock, abi.encodeWithSelector(IERC20.transferFrom.selector), 0);
        // #when
        _amend(alice, id, _terms(callStrike, ONE));
        // #then: the difference waits as a claim, and withdrawing it works like any payout
        assertEq(market.claimable(alice, stock), 2 * ONE);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), ONE);
        _assertConserved(_claimants());
        vm.prank(alice);
        market.withdraw(stock, 2 * ONE);
        assertEq(IERC20(stock).balanceOf(alice), before + 2 * ONE);
    }

    function test_growingABuyOrderPullsTheExtraUsdgAtItsTarget() public {
        // #given
        uint256 id = _placeAt(bob, OptionType.Put, putStrike, ONE);
        uint256 extra = _value(2 * ONE, putStrike);
        // #then
        vm.expectCall(usdg, abi.encodeCall(IERC20.transferFrom, (bob, address(market), extra)), 1);
        // #when
        _amend(bob, id, _terms(putStrike, 3 * ONE));
        // #then
        assertEq(market.orderOf(id).size, 3 * ONE);
        assertEq(market.claimable(bob, usdg), 0);
        _assertConserved(_claimants());
    }

    function test_shrinkingABuyOrderReleasesItsUsdgToClaimable() public {
        // #given
        uint256 id = _placeAt(bob, OptionType.Put, putStrike, 3 * ONE);
        // #then
        vm.expectCall(usdg, abi.encodeWithSelector(IERC20.transferFrom.selector), 0);
        // #when
        _amend(bob, id, _terms(putStrike, ONE));
        // #then
        assertEq(market.claimable(bob, usdg), _value(2 * ONE, putStrike));
        _assertConserved(_claimants());
    }

    function test_aLowerPriceAndALargerSizePullOnlyTheNetDifference() public {
        // #given
        uint256 id = _placeAt(bob, OptionType.Put, putStrike, ONE);
        uint256 lower = putStrike - strikeTick;
        uint256 owed = _value(2 * ONE, lower) - _value(ONE, putStrike);
        // #then
        vm.expectCall(usdg, abi.encodeCall(IERC20.transferFrom, (bob, address(market), owed)), 1);
        // #when
        _amend(bob, id, _terms(lower, 2 * ONE));
        // #then
        CollateralVault.Order memory o = market.orderOf(id);
        assertEq(o.target, lower);
        assertEq(o.size, 2 * ONE);
        assertEq(market.claimable(bob, usdg), 0);
        _assertConserved(_claimants());
    }

    function test_aHigherPriceAndASmallerSizeReleaseOnlyTheNetDifference() public {
        // #given
        uint256 lower = putStrike - strikeTick;
        uint256 id = _placeAt(bob, OptionType.Put, lower, 2 * ONE);
        uint256 freed = _value(2 * ONE, lower) - _value(ONE, putStrike);
        // #then
        vm.expectCall(usdg, abi.encodeWithSelector(IERC20.transferFrom.selector), 0);
        // #when
        _amend(bob, id, _terms(putStrike, ONE));
        // #then
        assertEq(market.claimable(bob, usdg), freed);
        assertEq(market.idleSize(stock, OptionType.Put, lower), 0);
        assertEq(market.idleSize(stock, OptionType.Put, putStrike), ONE);
        _assertConserved(_claimants());
    }

    // The order itself

    function test_anAmendedOrderKeepsItsIdAndChangesBucket() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        uint256 orders = market.orderCount();
        CollateralVault.AmendParams memory p = CollateralVault.AmendParams({
            target: callStrike + strikeTick,
            minPremium: PREMIUM,
            size: 2 * ONE,
            flip: true,
            flipTarget: putStrike
        });
        // #when
        _amend(alice, id, p);
        // #then
        CollateralVault.Order memory o = market.orderOf(id);
        assertEq(market.orderCount(), orders);
        assertEq(o.owner, alice);
        assertEq(o.asset, stock);
        assertEq(uint8(o.side), uint8(OptionType.Call));
        assertEq(uint8(o.status), uint8(CollateralVault.OrderStatus.Active));
        assertEq(o.target, callStrike + strikeTick);
        assertEq(o.minPremium, PREMIUM);
        assertEq(o.size, 2 * ONE);
        assertTrue(o.flip);
        assertEq(o.flipTarget, putStrike);
        assertEq(o.committed, 0);
        assertEq(o.series, 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike + strikeTick), 2 * ONE);
        assertEq(market.openSize(stock, OptionType.Call), 2 * ONE);
        assertEq(market.walletSize(alice, stock, OptionType.Call), 2 * ONE);
    }

    function test_anAmendEmitsItsFullNewTerms() public {
        // #given
        uint256 id = _placeAt(bob, OptionType.Put, putStrike, 2 * ONE);
        uint256 lower = putStrike - strikeTick;
        uint256 freed = _value(2 * ONE, putStrike) - _value(ONE, lower);
        CollateralVault.AmendParams memory p = CollateralVault.AmendParams({
            target: lower, minPremium: PREMIUM, size: ONE, flip: true, flipTarget: callStrike
        });
        // #then
        vm.expectEmit(address(market));
        emit CollateralVault.OrderAmended(id, lower, PREMIUM, ONE, true, callStrike);
        vm.expectEmit(address(market));
        emit CollateralVault.Credited(bob, usdg, freed);
        // #when
        _amend(bob, id, p);
    }

    function test_aFlipTargetIsDroppedWhenAnAmendTurnsFlipOff() public {
        // #given: a sell order that flips, amended with flip off and a stray flip target
        CollateralVault.OrderParams memory placed = _params(OptionType.Call, callStrike, ONE);
        (placed.flip, placed.flipTarget) = (true, putStrike);
        vm.prank(alice);
        uint256 id = market.placeOrder(placed);
        CollateralVault.AmendParams memory p = _terms(callStrike, ONE);
        p.flipTarget = putStrike + 1;
        // #then
        vm.expectEmit(address(market));
        emit CollateralVault.OrderAmended(id, callStrike, _floor(), ONE, false, 0);
        // #when
        _amend(alice, id, p);
        // #then
        assertFalse(market.orderOf(id).flip);
        assertEq(market.orderOf(id).flipTarget, 0);
    }

    function test_anAmendedOrderFillsOnlyInItsNewTargetsSeries() public {
        // #given: alice moves her sell order a tick up
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        _amend(alice, id, _terms(callStrike + strikeTick, ONE));
        uint256 series = market.seriesFor(stock, OCT_09, OptionType.Call, callStrike + strikeTick);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.SeriesMismatch.selector, id, callSeries)
        );
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #when
        _fillQuote(id, series, ONE);
        // #then
        assertEq(market.orderOf(id).series, series);
        assertEq(market.orderOf(id).committed, ONE);
        assertEq(market.poolOf(series).collateral, ONE);
        assertEq(market.claimable(alice, usdg), PREMIUM);
    }

    function test_anOrderCanBeAmendedOnceItsWeekSettles() public {
        // #given: a week written, run out and settled, so the order renews idle
        uint256 id = _writeCall(alice, ONE);
        _throughTheWindow();
        market.finalize(callSeries);
        market.settleOrder(id);
        // #when
        _amend(alice, id, _terms(callStrike + strikeTick, 2 * ONE));
        // #then
        CollateralVault.Order memory o = market.orderOf(id);
        assertEq(o.size, 2 * ONE);
        assertEq(o.target, callStrike + strikeTick);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike + strikeTick), 2 * ONE);
        _assertConserved(_claimants());
    }

    // Who and which orders

    function test_onlyTheOwnerCanAmend() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotOrderOwner.selector, id, bob));
        // #when
        _amend(bob, id, _terms(callStrike, 2 * ONE));
    }

    function test_anUnknownOrderCantBeAmended() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.UnknownOrder.selector, 42));
        // #when
        _amend(alice, 42, _terms(callStrike, ONE));
    }

    function test_aClosedOrderCantBeAmended() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.prank(alice);
        market.cancelOrder(id);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderNotActive.selector, id));
        // #when
        _amend(alice, id, _terms(callStrike, ONE));
    }

    function test_anOrderWrittenIntoThisWeekCantBeAmended() public {
        // #given: half of it written, half still uncommitted
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, 2 * ONE);
        _fillQuote(id, callSeries, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.OrderAttached.selector, id, callSeries)
        );
        // #when
        _amend(alice, id, _terms(callStrike, 2 * ONE));
    }

    function test_anOrderStoppedWhileWrittenCantBeAmended() public {
        // #given
        uint256 id = _writeCall(alice, ONE);
        vm.prank(alice);
        market.cancelOrder(id);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderNotActive.selector, id));
        // #when
        _amend(alice, id, _terms(callStrike, ONE));
    }

    // Placement rules

    function test_aSizeThatIsntWholeLotsOrZeroIsRefused() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotALot.selector, lot + 1, lot));
        // #when
        _amend(alice, id, _terms(callStrike, lot + 1));
        // #then
        vm.expectRevert(Units.ZeroAmount.selector);
        // #when
        _amend(alice, id, _terms(callStrike, 0));
    }

    function test_aTargetOffTheStrikeTickOrZeroIsRefused() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Units.NotOnTick.selector, callStrike + 1, strikeTick)
        );
        // #when
        _amend(alice, id, _terms(callStrike + 1, ONE));
        // #then
        vm.expectRevert(Units.ZeroAmount.selector);
        // #when
        _amend(alice, id, _terms(0, ONE));
    }

    function test_aMinimumPremiumOffThePriceTickIsRefused() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        CollateralVault.AmendParams memory p = _terms(callStrike, ONE);
        p.minPremium = priceTick + 1;
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotOnTick.selector, priceTick + 1, priceTick));
        // #when
        _amend(alice, id, p);
    }

    function test_aFlipTargetOffTheStrikeTickIsRefused() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        CollateralVault.AmendParams memory p = _terms(callStrike, ONE);
        (p.flip, p.flipTarget) = (true, putStrike + 1);
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotOnTick.selector, putStrike + 1, strikeTick));
        // #when
        _amend(alice, id, p);
    }

    function test_aDelistedAssetsOrdersCantBeAmendedButCanBeCancelled() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.prank(admin);
        registry.delist(stock);
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, stock));
        // #when
        _amend(alice, id, _terms(callStrike, 2 * ONE));
        // #when
        vm.prank(alice);
        market.cancelOrder(id);
        // #then
        assertEq(market.claimable(alice, stock), ONE);
    }

    function test_aPauseRefusesAnAmendEvenOneThatShrinksButNotACancel() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, 2 * ONE);
        vm.prank(guardian);
        market.setPaused(true);
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.MarketPaused.selector, stock));
        // #when
        _amend(alice, id, _terms(callStrike, ONE));
        // #when: the exit stays open
        vm.prank(alice);
        market.cancelOrder(id);
        // #then
        assertEq(market.claimable(alice, stock), 2 * ONE);
    }

    function test_anAssetPauseRefusesAnAmend() public {
        // #given
        uint256 id = _placeAt(bob, OptionType.Put, putStrike, ONE);
        vm.prank(guardian);
        market.setAssetPaused(stock, true);
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.MarketPaused.selector, stock));
        // #when
        _amend(bob, id, _terms(putStrike - strikeTick, ONE));
    }

    // Caps

    function test_theOldSizeIsReleasedBeforeTheCapsAreChecked() public {
        // #given: alice's one order fills her whole wallet cap
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, 4 * ONE);
        // #when: she moves all of it to another price
        _amend(alice, id, _terms(callStrike + strikeTick, 4 * ONE));
        // #then
        assertEq(market.walletSize(alice, stock, OptionType.Call), 4 * ONE);
        assertEq(market.openSize(stock, OptionType.Call), 4 * ONE);
        assertEq(market.orderOf(id).target, callStrike + strikeTick);
    }

    function test_anAmendOverTheWalletCapIsRefused() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, 3 * ONE);
        _placeAt(alice, OptionType.Call, callStrike, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector, MarketGuard.Cap.WalletSize, 4 * ONE + lot, 4 * ONE
            )
        );
        // #when
        _amend(alice, id, _terms(callStrike, 3 * ONE + lot));
    }

    function test_anAmendOverTheOpenSizeCapIsRefused() public {
        // #given
        _placeAt(alice, OptionType.Call, callStrike, 4 * ONE);
        _placeAt(bob, OptionType.Call, callStrike, 4 * ONE);
        uint256 id = _placeAt(carol, OptionType.Call, callStrike, 2 * ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector, MarketGuard.Cap.OpenSize, 10 * ONE + lot, 10 * ONE
            )
        );
        // #when
        _amend(carol, id, _terms(callStrike, 2 * ONE + lot));
    }

    function test_anAmendLeftOverALoweredCapIsRefusedAndTheOrderStands() public {
        // #given: the wallet cap drops under alice's live order
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, 4 * ONE);
        MarketGuard.Caps memory caps = market.capsOf(stock, OptionType.Call);
        caps.walletSize = 2 * ONE;
        vm.prank(timelock);
        market.setCaps(stock, OptionType.Call, caps);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketGuard.CapExceeded.selector, MarketGuard.Cap.WalletSize, 3 * ONE, 2 * ONE
            )
        );
        // #when
        _amend(alice, id, _terms(callStrike, 3 * ONE));
        // #then
        assertEq(market.orderOf(id).size, 4 * ONE);
        // #when: down to the new cap
        _amend(alice, id, _terms(callStrike, 2 * ONE));
        // #then
        assertEq(market.orderOf(id).size, 2 * ONE);
        assertEq(market.claimable(alice, stock), 2 * ONE);
    }
}

/// @notice Amends against the halt and the renewal batch: an order can't leave or enter a bucket
/// its batch holds, and orders amended before the bid window are counted where they are.
contract AmendOrderFreezeForkTest is AmendOrderFork {
    uint64 internal constant BID_OPEN = OCT_02 + 2 hours;
    uint64 internal constant BID_CLOSE = OCT_02 + 4 hours;
    // Sunday 20:00 ET, 13.5 hours before the Monday 09:30 ET creation deadline.
    uint64 internal constant DEADLINE = OCT_05_OPEN - 13 hours - 30 minutes;

    function _bid(uint256 premium, uint256 amount) internal {
        (QuoteSettlement.Quote memory q, bytes memory sig) =
            _signedQuoteAt(callSeries, amount, premium);
        market.submitBid(q, sig);
    }

    function _ids(uint256 x) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = x;
    }

    function _ids(uint256 x, uint256 y) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        (ids[0], ids[1]) = (x, y);
    }

    // Halt

    function test_aHaltRefusesAnAmend() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.prank(guardian);
        market.halt();
        uint64 end = uint64(vm.getBlockTimestamp() + 72 hours);
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.MarketHalted.selector, end));
        // #when
        _amend(alice, id, _terms(callStrike, 2 * ONE));
    }

    function test_anAmendGoesThroughOnceTheHaltEnds() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.prank(guardian);
        market.halt();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(guardian);
        market.endHalt();
        // #when
        _amend(alice, id, _terms(callStrike, 2 * ONE));
        // #then
        assertEq(market.orderOf(id).size, 2 * ONE);
    }

    // Freeze and the renewal batch

    function test_anAmendJustBeforeTheBidWindowGoesThroughAndOneAtItsOpeningDoesnt() public {
        // #given
        uint256 id = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.warp(BID_OPEN - 1);
        // #when
        _amend(alice, id, _terms(callStrike, 2 * ONE));
        // #then
        assertEq(market.orderOf(id).size, 2 * ONE);
        // #given
        vm.warp(BID_OPEN);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderFrozen.selector, id));
        // #when
        _amend(alice, id, _terms(callStrike, ONE));
    }

    function test_anOrderCantBeAmendedIntoABucketDuringItsBidWindow() public {
        // #given: bob's sell target is under the reference, so no batch ever holds his order
        uint256 b = _placeAt(bob, OptionType.Call, putStrike, ONE);
        vm.warp(BID_OPEN);
        assertFalse(market.frozen(b));
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.TargetFrozen.selector, b, callStrike)
        );
        // #when
        _amend(bob, b, _terms(callStrike, ONE));
    }

    function test_anOrderCantBeAmendedIntoABucketWhileItsBatchCounts() public {
        // #given: alice is the bucket, bob waits outside it, and the batch has opened
        uint256 a = _placeAt(alice, OptionType.Call, callStrike, ONE);
        uint256 b = _placeAt(bob, OptionType.Call, putStrike, ONE);
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.TargetFrozen.selector, b, callStrike)
        );
        // #when
        _amend(bob, b, _terms(callStrike, ONE));
        // #when: the batch runs to the end without him
        market.countBatch(callSeries, _ids(a));
        market.fillBatch(callSeries, _ids(a));
        _amend(bob, b, _terms(callStrike, ONE));
        // #then: he joins the bucket for next week, and alice's fill is untouched
        assertEq(uint8(market.batchOf(callSeries).phase), uint8(RenewalBatch.Phase.Done));
        assertEq(market.orderOf(a).committed, ONE);
        assertEq(market.orderOf(b).committed, 0);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), ONE);
        assertFalse(market.frozen(b));
        _assertConserved(_claimants());
    }

    function test_anOrderCantBeAmendedIntoABucketWhileItsSealedBatchFillsEvenAfterTheDeadline()
        public
    {
        // #given: sealed in time, not yet filled when the deadline passes
        uint256 a = _placeAt(alice, OptionType.Call, callStrike, ONE);
        uint256 b = _placeAt(bob, OptionType.Call, putStrike, ONE);
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a));
        vm.warp(DEADLINE + 1 hours);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.TargetFrozen.selector, b, callStrike)
        );
        // #when
        _amend(bob, b, _terms(callStrike, ONE));
        // #when
        market.fillBatch(callSeries, _ids(a));
        // #then
        assertEq(market.orderOf(a).committed, ONE);
        assertEq(market.claimable(alice, usdg), PREMIUM);
        _assertConserved(_claimants());
    }

    function test_anOrderCantBeAmendedOutOfABucketWhileItsBatchCounts() public {
        // #given
        uint256 a = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderFrozen.selector, a));
        // #when
        _amend(alice, a, _terms(putStrike, ONE));
    }

    function test_anOrderAmendedIntoABucketBeforeItsBidWindowIsCountedAtItsNewSize() public {
        // #given: bob moves into alice's bucket at twice his size before the window opens
        uint256 a = _placeAt(alice, OptionType.Call, callStrike, ONE);
        uint256 b = _placeAt(bob, OptionType.Call, putStrike, ONE);
        _amend(bob, b, _terms(callStrike, 2 * ONE));
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        // #then
        vm.expectEmit(address(market));
        emit RenewalBatch.BatchOpened(callSeries, quoter, PREMIUM, 3 * ONE, false);
        // #when
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, b));
        market.fillBatch(callSeries, _ids(a, b));
        // #then
        assertEq(market.orderOf(a).committed, ONE);
        assertEq(market.orderOf(b).committed, 2 * ONE);
        assertEq(market.claimable(bob, usdg), 2 * PREMIUM);
        _assertConserved(_claimants());
    }

    function test_anOrderAmendedOutOfABucketBeforeItsBidWindowIsLeftOut() public {
        // #given: bob leaves alice's bucket before the window opens
        uint256 a = _placeAt(alice, OptionType.Call, callStrike, ONE);
        uint256 b = _placeAt(bob, OptionType.Call, callStrike, ONE);
        _amend(bob, b, _terms(putStrike, ONE));
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.OrderNotInBatch.selector, b));
        // #when
        market.countBatch(callSeries, _ids(a, b));
        // #when
        market.countBatch(callSeries, _ids(a));
        // #then: alice alone seals it
        assertEq(uint8(market.batchOf(callSeries).phase), uint8(RenewalBatch.Phase.Filling));
        assertEq(market.batchOf(callSeries).total, ONE);
    }

    function test_ordersCanBeAmendedOnceAnUnsealedBatchDies() public {
        // #given: the batch opened but was never counted
        uint256 a = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        vm.warp(DEADLINE);
        // #when
        _amend(alice, a, _terms(callStrike + strikeTick, ONE));
        _amend(alice, a, _terms(callStrike, 2 * ONE));
        // #then
        assertEq(market.orderOf(a).size, 2 * ONE);
        assertEq(market.idleSize(stock, OptionType.Call, callStrike), 2 * ONE);
    }

    function test_aBucketNobodyBidOnUnfreezesAtTheDeadline() public {
        // #given
        uint256 a = _placeAt(alice, OptionType.Call, callStrike, ONE);
        vm.warp(DEADLINE - 1);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderFrozen.selector, a));
        // #when
        _amend(alice, a, _terms(callStrike, 2 * ONE));
        // #given
        vm.warp(DEADLINE);
        // #when
        _amend(alice, a, _terms(callStrike, 2 * ONE));
        // #then
        assertEq(market.orderOf(a).size, 2 * ONE);
    }
}
