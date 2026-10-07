// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VayleMarket} from "../../src/VayleMarket.sol";
import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {RenewalBatch} from "../../src/core/RenewalBatch.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {ChainActors, IOracleAdmin} from "../utils/ChainActors.sol";
import {MarketFork} from "../utils/MarketFork.sol";

/// @notice A market deployed two days before its schedule's first close (Sep 18) opens its first
/// week the afternoon before, on the feed's real price then, fills it by quote, and hands over to
/// the regular weekly cycle at the close.
contract FirstEpochForkTest is MarketFork {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant PREMIUM = 2_500_000;
    // Thursday Sep 17, 16:00 ET.
    uint64 internal constant OPENING = SEP_18 - 1 days;

    VayleMarket internal market;
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal maker;
    uint256 internal makerKey;
    uint256 internal nonce;
    uint80 internal openingRound;
    uint256 internal openingReference;
    uint256 internal callTarget;
    uint256 internal putTarget;

    event EpochCreated(
        address indexed asset,
        uint64 indexed expiry,
        uint64 opening,
        uint256 referencePrice,
        uint80 referenceRound,
        uint64 referenceUpdatedAt,
        uint32 windowLength
    );

    function setUp() public override {
        super.setUp();
        (maker, makerKey) = makeAddrAndKey("maker");
        market = _deployMarket(calendar, admin, guardian, admin);
        MarketGuard.Caps memory caps = MarketGuard.Caps({
            openSize: 10 * ONE, walletSize: 4 * ONE, seriesOpenInterest: 6 * ONE, fillSize: 2 * ONE
        });
        vm.startPrank(admin);
        market.setCaps(stock, OptionType.Call, caps);
        market.setCaps(stock, OptionType.Put, caps);
        market.setBatchBidder(maker, true);
        vm.stopPrank();
        address[3] memory wallets = [alice, bob, maker];
        for (uint256 i; i < wallets.length; ++i) {
            _fundStock(wallets[i], 10 * ONE);
            _fundUsdg(wallets[i], 100_000e6);
            vm.startPrank(wallets[i]);
            IERC20(stock).approve(address(market), type(uint256).max);
            IERC20(usdg).approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
        int256 answer;
        (openingRound, answer,) = _lastRoundAtOrBefore(OPENING - 1);
        openingReference = _referencePriceFrom(answer);
        // Targets out of the money at the opening and at the Sep 18 close, so both weeks list them.
        (, int256 closeAnswer,) = _lastRoundAtOrBefore(SEP_18);
        uint256 atClose = _referencePriceFrom(closeAnswer);
        uint256 high = atClose > openingReference ? atClose : openingReference;
        uint256 low = atClose < openingReference ? atClose : openingReference;
        callTarget = (high / strikeTick + 1) * strikeTick;
        putTarget = ((low - 1) / strikeTick) * strikeTick;
    }

    /// @dev Pings for the half hour before the opening, then opens the first week.
    function _openFirstWeek() internal returns (uint64) {
        _keepAlive(OPENING - 35 minutes, OPENING);
        return market.createFirstEpoch(stock, openingRound);
    }

    function _order(address owner, OptionType side, uint256 target) internal returns (uint256) {
        vm.prank(owner);
        return market.placeOrder(
            CollateralVault.OrderParams({
                asset: stock,
                side: side,
                target: target,
                minPremium: priceTick * 10,
                size: ONE,
                flip: false,
                flipTarget: 0
            })
        );
    }

    function _signed(uint256 series, uint256 amount, uint64 deadline)
        internal
        returns (QuoteSettlement.Quote memory q, bytes memory sig)
    {
        q = QuoteSettlement.Quote({
            maker: maker,
            taker: address(0),
            series: series,
            premium: PREMIUM,
            maxFeeBps: 0,
            maxAmount: amount,
            minFill: lot,
            nonce: ++nonce,
            deadline: deadline
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, market.quoteDigest(q));
        sig = abi.encodePacked(r, s, v);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function test_opensNowAndRunsToTheFirstClose() public {
        // #given
        _keepAlive(OPENING - 35 minutes, OPENING);
        (,, uint256 updatedAt) = _lastRoundAtOrBefore(OPENING - 1);
        // #then
        vm.expectEmit(address(market));
        emit EpochCreated(
            stock, SEP_18, OPENING, openingReference, openingRound, uint64(updatedAt), 2 hours
        );
        // #when
        uint64 expiry = market.createFirstEpoch(stock, openingRound);
        // #then
        EpochBook.Epoch memory e = market.epoch(stock, expiry);
        assertEq(expiry, SEP_18);
        assertEq(e.opening, OPENING);
        assertEq(e.batchDeadline, OPENING);
        assertEq(e.referencePrice, openingReference);
        assertEq(e.strikeTick, strikeTick);
        assertEq(market.latestExpiry(stock), SEP_18);
        assertTrue(market.isListedStrike(stock, SEP_18, OptionType.Call, callTarget));
    }

    function test_fillsByQuoteAllWeekWithNoBidBatchOrFreeze() public {
        // #given: an order placed in the first week, at a time a regular week would be in its
        // bid window
        _openFirstWeek();
        uint256 sell = _order(alice, OptionType.Call, callTarget);
        uint256 series = market.seriesFor(stock, SEP_18, OptionType.Call, callTarget);
        _keepAlive(OPENING + 1 minutes, OPENING + 3 hours);
        (QuoteSettlement.Quote memory bid, bytes memory bidSig) = _signed(series, ONE, SEP_18);
        // #then
        assertFalse(market.frozen(sell));
        vm.expectRevert(
            abi.encodeWithSelector(
                RenewalBatch.OutsideBidWindow.selector, series, OPENING + 2 hours, OPENING
            )
        );
        market.submitBid(bid, bidSig);
        // #when
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signed(series, ONE / 2, SEP_18);
        market.fillQuote(q, sig, sell, ONE / 2);
        // #then
        assertEq(market.orderOf(sell).series, series);
        assertEq(market.orderOf(sell).committed, ONE / 2);
        assertEq(market.claimable(alice, usdg), PREMIUM / 2);
    }

    function test_theFirstWeekSettlesAndItsOrdersRenewIntoTheNextBatch() public {
        // #given: alice's sell order half filled by quote in the first week, bob's buy order unfilled
        _openFirstWeek();
        uint256 sell = _order(alice, OptionType.Call, callTarget);
        uint256 buy = _order(bob, OptionType.Put, putTarget);
        uint256 firstCalls = market.seriesFor(stock, SEP_18, OptionType.Call, callTarget);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signed(firstCalls, ONE / 2, SEP_18);
        market.fillQuote(q, sig, sell, ONE / 2);
        (uint80 closeRound,,) = _lastRoundAtOrBefore(SEP_18);

        // #when: the regular week opens at the close, the first week's window runs out
        // unexercised, it settles, and both orders go through the new week's batch
        _runKeeper(EpochBook(market), SEP_18, SEP_18 - KEEPER_LEAD, SEP_18 + 10 minutes);
        uint64 next = market.createEpoch(stock, closeRound);
        _keepAlive(SEP_18 + 11 minutes, SEP_18 + 2 hours);
        market.finalize(firstCalls);
        market.settleOrder(sell);
        uint256 calls = market.seriesFor(stock, next, OptionType.Call, callTarget);
        uint256 puts = market.seriesFor(stock, next, OptionType.Put, putTarget);
        (q, sig) = _signed(calls, 5 * ONE, next);
        market.submitBid(q, sig);
        (q, sig) = _signed(puts, 5 * ONE, next);
        market.submitBid(q, sig);
        _keepAlive(SEP_18 + 2 hours + 1 minutes, SEP_18 + 4 hours);
        uint256[2] memory series = [calls, puts];
        uint256[2] memory orders = [sell, buy];
        for (uint256 i; i < 2; ++i) {
            market.openBatch(series[i]);
            market.countBatch(series[i], _one(orders[i]));
            market.fillBatch(series[i], _one(orders[i]));
        }

        // #then
        assertEq(next, SEP_25);
        assertEq(market.epoch(stock, next).opening, SEP_18);
        assertEq(market.orderOf(sell).series, calls);
        assertEq(market.orderOf(sell).committed, ONE);
        assertEq(market.orderOf(buy).series, puts);
        assertEq(market.orderOf(buy).committed, ONE);
        assertEq(market.claimable(alice, usdg), PREMIUM / 2 + PREMIUM);
        assertEq(market.claimable(bob, usdg), PREMIUM);
    }

    function test_refusesASecondFirstEpoch() public {
        // #given
        _openFirstWeek();
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.EpochExists.selector, stock, SEP_18));
        // #when
        market.createFirstEpoch(stock, openingRound);
    }

    function test_refusesOnceTheFirstCloseHasPassed() public {
        // #given
        _keepAlive(SEP_18 - 35 minutes, SEP_18 + 1 minutes);
        (uint80 round,,) = _lastRoundAtOrBefore(SEP_18);
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.FirstCloseHasPassed.selector, SEP_18));
        // #when
        market.createFirstEpoch(stock, round);
    }

    function test_refusesWithinTheLookbackAfterDeploy() public {
        // #given
        uint64 earliest = market.deployedAt() + market.LIVENESS_LOOKBACK();
        _keepAlive(market.deployedAt(), earliest - 1 minutes);
        (uint80 round,,) = _lastRoundAtOrBefore(earliest - 1 minutes - 1);
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.TooSoonAfterDeploy.selector, earliest));
        // #when
        market.createFirstEpoch(stock, round);
    }

    function test_refusesAfterALivenessGapInTheLookback() public {
        // #given: nobody pinged for the twenty minutes before the opening
        _keepAlive(OPENING - 35 minutes, OPENING - 20 minutes);
        vm.warp(OPENING);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(EpochBook.LivenessGapAtClose.selector, OPENING, 20 minutes)
        );
        // #when
        market.createFirstEpoch(stock, openingRound);
    }

    function test_refusesWhileHalted() public {
        // #given
        _keepAlive(OPENING - 35 minutes, OPENING);
        vm.prank(guardian);
        market.halt();
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(MarketGuard.MarketHalted.selector, OPENING + 72 hours)
        );
        // #when
        market.createFirstEpoch(stock, openingRound);
    }

    function test_refusesWhileTheOracleIsPaused() public {
        // #given: the real pauser pauses NVDA's oracle
        _keepAlive(OPENING - 35 minutes, OPENING);
        vm.prank(ChainActors.ORACLE_PAUSER);
        IOracleAdmin(stock).pauseOracle();
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.OraclePaused.selector, stock));
        // #when
        market.createFirstEpoch(stock, openingRound);
    }

    function test_refusesWithoutASchedule() public {
        // #given: a market whose calendar holds no closes
        SessionCalendar empty = new SessionCalendar(admin, new SessionCalendar.Boundary[](0));
        VayleMarket bare = _deployMarket(empty, admin, guardian, admin);
        _keepAlive(OPENING - 35 minutes, OPENING);
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NoCloseAfter.selector, OPENING));
        // #when
        bare.createFirstEpoch(stock, openingRound);
    }
}
