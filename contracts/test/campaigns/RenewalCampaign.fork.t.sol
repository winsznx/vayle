// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {RenewalBatch} from "../../src/core/RenewalBatch.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice Campaign B, renewal: random batches checked against an independent pro rata
/// computation, and the opt-in flip after a fill.
contract RenewalCampaignForkTest is VayleMarketFork {
    uint64 internal constant BID_OPEN = OCT_02 + 2 hours;
    uint64 internal constant BID_CLOSE = OCT_02 + 4 hours;
    uint256 internal constant MAX_ORDERS = 6;

    struct BatchPlan {
        uint8 count;
        uint8[6] owners;
        uint16[6] lots;
        uint16[6] floorTicks;
        uint32 bidTicks;
        uint16 bidLots;
        uint16 seriesCapLots;
        uint16 fillCapLots;
        uint16 feeBps;
    }

    struct Expected {
        uint256 eligible;
        uint256 capacity;
        uint256 written;
    }

    function _wideCaps(uint256 seriesCap, uint256 fillCap)
        internal
        pure
        returns (MarketGuard.Caps memory)
    {
        return MarketGuard.Caps({
            openSize: 100 * ONE,
            walletSize: 100 * ONE,
            seriesOpenInterest: seriesCap,
            fillSize: fillCap
        });
    }

    function _placeFromPlan(BatchPlan memory plan, uint256 i) internal returns (uint256 id) {
        address owner = [alice, bob, carol][plan.owners[i] % 3];
        CollateralVault.OrderParams memory p =
            _params(OptionType.Call, callStrike, bound(plan.lots[i], 1, 100) * lot);
        p.minPremium = bound(plan.floorTicks[i], 0, 2000) * priceTick;
        vm.prank(owner);
        id = market.placeOrder(p);
    }

    /// @dev The pro rata share each eligible order should get, worked out from the plan alone.
    function _expectedFill(uint256 size, Expected memory x, uint256 fillCap)
        internal
        view
        returns (uint256 amount)
    {
        amount = (size * x.capacity) / x.eligible;
        if (amount > fillCap) amount = fillCap;
        amount -= amount % lot;
    }

    function _eligibleIds(uint256[] memory ids, uint256 premium)
        internal
        view
        returns (uint256[] memory eligible)
    {
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (market.orderOf(ids[i]).minPremium <= premium) ++n;
        }
        eligible = new uint256[](n);
        n = 0;
        for (uint256 i; i < ids.length; ++i) {
            if (market.orderOf(ids[i]).minPremium <= premium) eligible[n++] = ids[i];
        }
    }

    /// forge-config: default.fuzz.runs = 256
    /// forge-config: ci.fuzz.runs = 1024
    function testFuzz_aBatchTreatsEveryHolderAlike(BatchPlan memory plan) public {
        // #given: random orders, minimums, caps, fee and one bid
        uint256 fillCap = bound(plan.fillCapLots, 1, 200) * lot;
        uint256 seriesCap = bound(plan.seriesCapLots, 1, 600) * lot;
        uint16 feeBps = uint16(bound(plan.feeBps, 0, 500));
        vm.startPrank(timelock);
        market.setCaps(stock, OptionType.Call, _wideCaps(seriesCap, fillCap));
        market.setFee(feeBps, treasury);
        vm.stopPrank();
        uint256[] memory ids = new uint256[](bound(plan.count, 1, MAX_ORDERS));
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = _placeFromPlan(plan, i);
        }
        uint256 premium = bound(plan.bidTicks, 0, 2000) * priceTick;
        uint256 bidAmount = bound(plan.bidLots, 1, 600) * lot;

        // #when
        vm.warp(BID_OPEN);
        (QuoteSettlement.Quote memory q, bytes memory sig) =
            _signedQuoteAt(callSeries, bidAmount, premium);
        market.submitBid(q, sig);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, ids);
        Expected memory x;
        for (uint256 i; i < ids.length; ++i) {
            CollateralVault.Order memory o = market.orderOf(ids[i]);
            if (o.minPremium <= premium) x.eligible += o.size;
        }
        uint256 capacity = bidAmount < x.eligible ? bidAmount : x.eligible;
        capacity = capacity < seriesCap ? capacity : seriesCap;
        x.capacity = capacity - capacity % lot;
        if (market.batchOf(callSeries).phase == RenewalBatch.Phase.Filling) {
            market.fillBatch(callSeries, _eligibleIds(ids, premium));
        }

        // #then: every order got exactly its share, or nothing when its minimum is above the bid
        for (uint256 i; i < ids.length; ++i) {
            CollateralVault.Order memory o = market.orderOf(ids[i]);
            uint256 want = o.minPremium <= premium ? _expectedFill(o.size, x, fillCap) : 0;
            assertEq(o.committed, want, "pro rata share");
            x.written += want;
        }
        assertLe(x.written, x.capacity, "within capacity");
        assertEq(uint8(market.batchOf(callSeries).phase), uint8(RenewalBatch.Phase.Done));
        uint256 premiumValue = Units.valueExact(x.written, premium, RAW_UNIT);
        assertEq(market.claimable(treasury, usdg), Units.fee(premiumValue, feeBps), "fee");
        _assertConserved(_claimants());
    }

    // Flip

    function _flipOrder(OptionType side, uint256 flipTarget) internal returns (uint256 id) {
        CollateralVault.OrderParams memory p =
            _params(side, side == OptionType.Call ? callStrike : putStrike, ONE);
        (p.flip, p.flipTarget) = (true, flipTarget);
        vm.prank(alice);
        id = market.placeOrder(p);
        _fillQuote(id, side == OptionType.Call ? callSeries : putSeries, ONE);
    }

    function _exerciseAndSettle(uint256 id, uint256 series) internal {
        _intoTheWindow();
        vm.prank(quoter);
        market.exercise(series, ONE);
        _pastTheWindow();
        market.finalize(series);
        market.settleOrder(id);
    }

    function test_aFilledSellOrderWithFlipBecomesABuyOrderAtTheFlipTarget() public {
        // #given: alice sells one NVDA at the call strike and wants to buy back at the put strike
        uint256 id = _flipOrder(OptionType.Call, putStrike);
        // #when
        _exerciseAndSettle(id, callSeries);
        // #then: the strike she received buys as many whole lots as it covers at the put strike
        uint256 perLot = Units.valueExact(lot, putStrike, RAW_UNIT);
        uint256 lots = callStrike / perLot;
        CollateralVault.Order memory flipped = market.orderOf(market.orderCount());
        assertEq(uint8(flipped.side), uint8(OptionType.Put));
        assertEq(flipped.target, putStrike);
        assertEq(flipped.size, lots * lot);
        assertFalse(flipped.flip);
        assertEq(market.claimable(alice, usdg), PREMIUM + callStrike - lots * perLot);
        _assertConserved(_claimants());
    }

    function test_aFilledBuyOrderWithFlipBecomesASellOrder() public {
        // #given
        uint256 id = _flipOrder(OptionType.Put, callStrike);
        // #when
        _exerciseAndSettle(id, putSeries);
        // #then
        CollateralVault.Order memory flipped = market.orderOf(market.orderCount());
        assertEq(uint8(flipped.side), uint8(OptionType.Call));
        assertEq(flipped.size, ONE);
        assertEq(market.claimable(alice, stock), 0);
    }

    function test_aFlipIntoAClosedSideCreditsTheProceedsInstead() public {
        // #given: buy orders are closed
        MarketGuard.Caps memory closed;
        vm.prank(timelock);
        market.setCaps(stock, OptionType.Put, closed);
        uint256 id = _flipOrder(OptionType.Call, putStrike);
        uint256 orders = market.orderCount();
        // #when
        _exerciseAndSettle(id, callSeries);
        // #then
        assertEq(market.orderCount(), orders);
        assertEq(market.claimable(alice, usdg), PREMIUM + callStrike);
    }

    function test_aCancelledOrderNeverFlips() public {
        // #given: filled, then cancelled by its holder
        uint256 id = _flipOrder(OptionType.Call, putStrike);
        vm.prank(alice);
        market.cancelOrder(id);
        uint256 orders = market.orderCount();
        // #when
        _exerciseAndSettle(id, callSeries);
        // #then
        assertEq(market.orderCount(), orders);
        assertEq(market.claimable(alice, usdg), PREMIUM + callStrike);
    }

    function test_withoutFlipAFilledOrderStops() public {
        // #given
        uint256 id = _writeCall(alice, ONE);
        uint256 orders = market.orderCount();
        // #when
        _exerciseAndSettle(id, callSeries);
        // #then
        assertEq(uint8(market.orderOf(id).status), uint8(CollateralVault.OrderStatus.Closed));
        assertEq(market.orderCount(), orders);
    }
}
