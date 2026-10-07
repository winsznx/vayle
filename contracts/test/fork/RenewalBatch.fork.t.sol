// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {RenewalBatch} from "../../src/core/RenewalBatch.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice The weekly renewal batch on the Oct 2 epoch: bids, one clearing price, pro rata cuts,
/// completeness, the freeze, escrow and the deadline.
contract RenewalBatchForkTest is VayleMarketFork {
    uint64 internal constant BID_OPEN = OCT_02 + 2 hours;
    uint64 internal constant BID_CLOSE = OCT_02 + 4 hours;
    // Sunday 20:00 ET, 13.5 hours before the Monday 09:30 ET creation deadline.
    uint64 internal constant DEADLINE = OCT_05_OPEN - 13 hours - 30 minutes;

    uint256 internal a;
    uint256 internal b;
    uint256 internal c;

    /// @dev Three call orders in one bucket: alice and bob accept the bid, carol wants twice it.
    function setUp() public override {
        super.setUp();
        a = _placeAt(alice, OptionType.Call, ONE, priceTick * 10);
        b = _placeAt(bob, OptionType.Call, 2 * ONE, PREMIUM);
        c = _placeAt(carol, OptionType.Call, ONE, 2 * PREMIUM);
    }

    function _placeAt(address owner, OptionType side, uint256 size, uint256 minPremium)
        internal
        returns (uint256 id)
    {
        CollateralVault.OrderParams memory p =
            _params(side, side == OptionType.Call ? callStrike : putStrike, size);
        p.minPremium = minPremium;
        vm.prank(owner);
        id = market.placeOrder(p);
    }

    function _bid(uint256 premium, uint256 amount) internal returns (bytes32 digest) {
        (QuoteSettlement.Quote memory q, bytes memory sig) =
            _signedQuoteAt(callSeries, amount, premium);
        market.submitBid(q, sig);
        return market.quoteDigest(q);
    }

    function _ids(uint256 x, uint256 y, uint256 z) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (x, y, z);
    }

    function _ids(uint256 x, uint256 y) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        (ids[0], ids[1]) = (x, y);
    }

    /// @dev A bid in the window, then the whole batch: open, count everyone, fill the eligible.
    function _runBatch(uint256 premium, uint256 amount) internal {
        vm.warp(BID_OPEN);
        _bid(premium, amount);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, b, c));
        market.fillBatch(callSeries, _ids(a, b));
    }

    // One clearing price

    function test_aBatchFillsEveryEligibleOrderAtTheBestBid() public {
        // #when
        _runBatch(PREMIUM, 10 * ONE);
        // #then
        assertEq(market.orderOf(a).committed, ONE);
        assertEq(market.orderOf(b).committed, 2 * ONE);
        assertEq(market.claimable(alice, usdg), PREMIUM);
        assertEq(market.claimable(bob, usdg), 2 * PREMIUM);
        assertEq(market.balanceOf(quoter, callSeries), 3 * ONE);
        _assertConserved(_claimants());
    }

    function test_aBidFromAMakerTheOwnerHasntApprovedIsRefused() public {
        // #given: a funded stranger signs the highest bid of the week
        (address stranger, uint256 strangerKey) = makeAddrAndKey("stranger");
        QuoteSettlement.Quote memory q = QuoteSettlement.Quote({
            maker: stranger,
            taker: address(0),
            series: callSeries,
            premium: 10 * PREMIUM,
            maxFeeBps: market.feeBps(),
            maxAmount: ONE,
            minFill: lot,
            nonce: 1,
            deadline: OCT_09
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerKey, market.quoteDigest(q));
        vm.warp(BID_OPEN);
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.NotABatchBidder.selector, stranger));
        // #when
        market.submitBid(q, abi.encodePacked(r, s, v));
    }

    function test_aBatchByATeamMakerIsTaggedOnChain() public {
        // #given
        vm.prank(timelock);
        market.setTeamOperated(quoter, true);
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        // #then: alice, bob and carol's four tokens are the bucket the batch opens on
        vm.expectEmit(address(market));
        emit RenewalBatch.BatchOpened(callSeries, quoter, PREMIUM, 4 * ONE, true);
        // #when
        market.openBatch(callSeries);
    }

    function test_anOrderWhoseMinimumIsAboveTheBidIsSkippedAndUntouched() public {
        // #when
        _runBatch(PREMIUM, 10 * ONE);
        // #then
        CollateralVault.Order memory skipped = market.orderOf(c);
        assertEq(skipped.committed, 0);
        assertEq(skipped.series, 0);
        assertEq(market.claimable(carol, usdg), 0);
    }

    function test_aShortBidCutsEveryOrderByTheSameShare() public {
        // #when: the bid covers half of the three eligible tokens
        _runBatch(PREMIUM, 3 * ONE / 2);
        // #then
        assertEq(market.orderOf(a).committed, ONE / 2);
        assertEq(market.orderOf(b).committed, ONE);
        _assertConserved(_claimants());
    }

    function test_theSeriesCapCutsTheBatchProRata() public {
        // #given: room for one token in the series
        MarketGuard.Caps memory caps = market.capsOf(stock, OptionType.Call);
        caps.seriesOpenInterest = ONE;
        vm.prank(timelock);
        market.setCaps(stock, OptionType.Call, caps);
        // #when
        _runBatch(PREMIUM, 10 * ONE);
        // #then: a third and two thirds of a token, floored to lots
        assertEq(market.orderOf(a).committed, 33 * lot);
        assertEq(market.orderOf(b).committed, 66 * lot);
    }

    function test_theHighestBidSetsThePrice() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        _bid(PREMIUM + priceTick, 10 * ONE);
        // #when
        RenewalBatch.Bid memory best = market.bestBid(callSeries);
        // #then
        assertEq(best.premium, PREMIUM + priceTick);
    }

    function test_anEqualLaterBidDoesntReplaceTheEarlierOne() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        _bid(PREMIUM, 2 * ONE);
        // #when
        RenewalBatch.Bid memory best = market.bestBid(callSeries);
        // #then
        assertEq(best.amount, ONE);
    }

    function test_aBidIsUsedUpSoItCantAlsoFillByQuote() public {
        // #given
        vm.warp(BID_OPEN);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        market.submitBid(q, sig);
        vm.warp(DEADLINE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                QuoteSettlement.QuoteOverfilled.selector, market.quoteDigest(q), ONE, ONE, ONE
            )
        );
        // #when
        market.fillQuote(q, sig, a, ONE);
    }

    // Windows and deadlines

    function test_aBidBeforeTheWindowOpensIsRefused() public {
        // #given
        vm.warp(BID_OPEN - 1);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                RenewalBatch.OutsideBidWindow.selector, callSeries, BID_OPEN, DEADLINE
            )
        );
        // #when
        market.submitBid(q, sig);
    }

    function test_aBatchWontOpenBeforeEveryMakerHadTheWholeWindow() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE - 1);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                RenewalBatch.OutsideBidWindow.selector, callSeries, BID_CLOSE, DEADLINE
            )
        );
        // #when
        market.openBatch(callSeries);
    }

    function test_aBatchWontOpenWithoutABid() public {
        // #given
        vm.warp(BID_CLOSE);
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.NoBid.selector, callSeries));
        // #when
        market.openBatch(callSeries);
    }

    function test_aBatchWaitsUntilEveryOrderInItsBucketIsSettled() public {
        // #given: one of the bucket's orders is attached to a series
        _fillQuote(a, callSeries, lot);
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(RenewalBatch.BucketStillAttached.selector, callSeries, 1)
        );
        // #when
        market.openBatch(callSeries);
    }

    function test_anUnsealedBatchDiesAtTheDeadline() public {
        // #given: the batch opened, but only part of the bucket was counted
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, b));
        vm.warp(DEADLINE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                RenewalBatch.OutsideBidWindow.selector, callSeries, BID_CLOSE, DEADLINE
            )
        );
        // #when
        uint256[] memory last = new uint256[](1);
        last[0] = c;
        market.countBatch(callSeries, last);
    }

    function test_ordersUnfreezeWhenAnUnsealedBatchDies() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        vm.warp(DEADLINE);
        // #when
        vm.prank(alice);
        market.cancelOrder(a);
        // #then
        assertEq(uint8(market.orderOf(a).status), uint8(CollateralVault.OrderStatus.Closed));
    }

    function test_aSealedBatchStillFinishesAfterTheDeadline() public {
        // #given: sealed in time, filled after the deadline
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, b, c));
        vm.warp(DEADLINE + 1 hours);
        // #when
        market.fillBatch(callSeries, _ids(a, b));
        // #then
        assertEq(uint8(market.batchOf(callSeries).phase), uint8(RenewalBatch.Phase.Done));
    }

    // Completeness and order

    function test_countingOutOfOrderIsRefused() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.OrdersOutOfOrder.selector, a, b));
        // #when
        market.countBatch(callSeries, _ids(b, a));
    }

    function test_countingAnOrderTwiceIsRefused() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.OrdersOutOfOrder.selector, a, a));
        // #when
        market.countBatch(callSeries, _ids(a, a));
    }

    function test_anOrderFromAnotherBucketCantBeCounted() public {
        // #given
        uint256 put = _placeAt(alice, OptionType.Put, ONE, 0);
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.OrderNotInBatch.selector, put));
        // #when
        market.countBatch(callSeries, _ids(a, put));
    }

    function test_leavingAnOrderOutKeepsTheBatchFromSealing() public {
        // #given: the runner counts alice and carol but not bob
        vm.warp(BID_OPEN);
        _bid(PREMIUM, ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, c));
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                RenewalBatch.WrongPhase.selector, callSeries, RenewalBatch.Phase.Counting
            )
        );
        // #when
        market.fillBatch(callSeries, _ids(a, b));
    }

    function test_anOrderPlacedAfterTheBatchOpenedIsLeftOut() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        uint256 late = _placeAt(carol, OptionType.Call, ONE, 0);
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.OrdersOutOfOrder.selector, late, c));
        // #when
        uint256[] memory ids = new uint256[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (a, b, c, late);
        market.countBatch(callSeries, ids);
    }

    function test_fillingASkippedOrderIsRefused() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, b, c));
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.OrderNotInBatch.selector, c));
        // #when
        market.fillBatch(callSeries, _ids(a, c));
    }

    // Freeze

    function test_ordersInTheBucketFreezeWhenTheBidWindowOpens() public {
        // #given
        vm.warp(BID_OPEN);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderFrozen.selector, a));
        // #when
        vm.prank(alice);
        market.cancelOrder(a);
    }

    function test_aFrozenOrderCantBeEdited() public {
        // #given
        vm.warp(BID_OPEN);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderFrozen.selector, b));
        // #when
        vm.prank(bob);
        market.updateOrder(b, PREMIUM, false, 0);
    }

    function test_aFrozenOrderCantBeFilledByQuote() public {
        // #given
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.warp(BID_OPEN);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderFrozen.selector, a));
        // #when
        market.fillQuote(q, sig, a, ONE);
    }

    function test_anOrderWhoseTargetTheMarketPassedIsntFrozen() public {
        // #given: a put order targeting a strike above the reference, which isn't listed
        uint256 itm = callStrike;
        CollateralVault.OrderParams memory p = _params(OptionType.Put, itm, ONE);
        vm.prank(alice);
        uint256 id = market.placeOrder(p);
        vm.warp(BID_OPEN);
        // #when
        bool isFrozen = market.frozen(id);
        // #then
        assertFalse(isFrozen);
    }

    function test_ordersUnfreezeOnceTheirBatchIsDone() public {
        // #given
        _runBatch(PREMIUM, 10 * ONE);
        // #when
        vm.prank(carol);
        market.cancelOrder(c);
        // #then
        assertEq(uint8(market.orderOf(c).status), uint8(CollateralVault.OrderStatus.Closed));
    }

    // Escrow, fees and stuck batches

    function test_theMakersPremiumIsEscrowedWhenTheBatchSeals() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        uint256 before = IERC20(usdg).balanceOf(quoter);
        // #when
        market.countBatch(callSeries, _ids(a, b, c));
        // #then: three eligible tokens at the bid, before any long exists
        assertEq(before - IERC20(usdg).balanceOf(quoter), 3 * PREMIUM);
        assertEq(market.totalSupply(callSeries), 0);
    }

    function test_unusedEscrowGoesBackToTheMaker() public {
        // #given: a cap that floors fills below the escrowed capacity
        MarketGuard.Caps memory caps = market.capsOf(stock, OptionType.Call);
        caps.seriesOpenInterest = ONE;
        vm.prank(timelock);
        market.setCaps(stock, OptionType.Call, caps);
        // #when
        _runBatch(PREMIUM, 10 * ONE);
        // #then: escrow for one token, 0.99 written
        assertEq(market.claimable(quoter, usdg), Units.valueExact(lot, PREMIUM, RAW_UNIT));
        _assertConserved(_claimants());
    }

    function test_theFeeIsChargedOnWhatWasWritten() public {
        // #given
        vm.prank(timelock);
        market.setFee(100, treasury);
        // #when
        _runBatch(PREMIUM, 10 * ONE);
        // #then
        assertEq(market.claimable(treasury, usdg), Units.fee(3 * PREMIUM, 100));
        _assertConserved(_claimants());
    }

    function test_aMakerThatCantPayTheEscrowCantSealAndNothingFills() public {
        // #given: the maker empties its wallet before the seal
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        address sink = makeAddr("sink");
        uint256 balance = IERC20(usdg).balanceOf(quoter);
        vm.prank(quoter);
        IERC20(usdg).transfer(sink, balance);
        // #then
        vm.expectRevert();
        // #when
        market.countBatch(callSeries, _ids(a, b, c));
    }

    function test_aSealedBatchThatCantFillCanBeClosedAfterTheDeadline() public {
        // #given: sealed, then the guardian pauses new positions past the deadline
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, b, c));
        vm.prank(guardian);
        market.setPaused(true);
        vm.warp(DEADLINE);
        // #when
        market.closeBatch(callSeries);
        // #then: the whole escrow goes back and the orders are free
        assertEq(market.claimable(quoter, usdg), 3 * PREMIUM);
        assertFalse(market.frozen(a));
    }

    function test_aRunningBatchCantBeClosed() public {
        // #given
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        market.countBatch(callSeries, _ids(a, b, c));
        // #then
        vm.expectRevert(abi.encodeWithSelector(RenewalBatch.BatchStillRunning.selector, callSeries));
        // #when
        market.closeBatch(callSeries);
    }

    function test_aFeeRaisedAboveTheBidsLimitBlocksTheSeal() public {
        // #given: a bid signed at a 0% fee, then the fee goes to 1%
        vm.warp(BID_OPEN);
        _bid(PREMIUM, 10 * ONE);
        vm.prank(timelock);
        market.setFee(100, treasury);
        vm.warp(BID_CLOSE);
        market.openBatch(callSeries);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.FeeAboveQuote.selector, 100, 0));
        // #when
        market.countBatch(callSeries, _ids(a, b, c));
    }
}
