// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VayleMarket} from "../../src/VayleMarket.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {MarketFork} from "../utils/MarketFork.sol";

/// @notice Campaign B, the real loop: two standing orders renew from the Sep 25 week into the
/// Oct 2 week on the feed's real closes. One is partly filled in between, and its remainder renews.
contract TwoWeekRenewalForkTest is MarketFork {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant PREMIUM = 2_500_000;

    VayleMarket internal market;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal maker;
    uint256 internal makerKey;
    uint256 internal nonce;
    uint256 internal callTarget;
    uint256 internal putTarget;

    function setUp() public override {
        super.setUp();
        (maker, makerKey) = makeAddrAndKey("maker");
        market = _deployMarket(calendar, admin, makeAddr("guardian"), admin);
        MarketGuard.Caps memory caps = MarketGuard.Caps({
            openSize: 10 * ONE, walletSize: 4 * ONE, seriesOpenInterest: 6 * ONE, fillSize: 2 * ONE
        });
        vm.startPrank(admin);
        market.setCaps(nvda, OptionType.Call, caps);
        market.setCaps(nvda, OptionType.Put, caps);
        market.setBatchBidder(maker, true);
        vm.stopPrank();
        address[3] memory wallets = [alice, bob, maker];
        for (uint256 i; i < wallets.length; ++i) {
            vm.startPrank(ChainActors.FUNDING_SOURCE);
            IERC20(nvda).transfer(wallets[i], 10 * ONE);
            IERC20(usdg).transfer(wallets[i], 100_000e6);
            vm.stopPrank();
            vm.startPrank(wallets[i]);
            IERC20(nvda).approve(address(market), type(uint256).max);
            IERC20(usdg).approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
        // Targets out of the money at both closes, so both weeks list them.
        (,, uint256 sep25) = _roundAt(SEP_25);
        (,, uint256 oct02) = _roundAt(OCT_02);
        uint256 high = sep25 > oct02 ? sep25 : oct02;
        uint256 low = sep25 < oct02 ? sep25 : oct02;
        callTarget = (high / STRIKE_TICK + 1) * STRIKE_TICK;
        putTarget = ((low - 1) / STRIKE_TICK) * STRIKE_TICK;
    }

    /// @return round The feed's last round at or before `close`.
    /// @return answer Its answer.
    /// @return price The reference price that answer gives.
    function _roundAt(uint64 close)
        internal
        view
        returns (uint80 round, int256 answer, uint256 price)
    {
        (round, answer,) = _lastRoundAtOrBefore(close);
        price = _referencePriceFrom(answer);
    }

    function _openWeek(uint64 close) internal {
        (uint80 round,,) = _roundAt(close);
        _runKeeper(EpochBook(market), close, close - KEEPER_LEAD, close + 10 minutes);
        market.createEpoch(nvda, round);
    }

    function _order(address owner, OptionType side, uint256 target) internal returns (uint256) {
        vm.prank(owner);
        return market.placeOrder(
            CollateralVault.OrderParams({
                asset: nvda,
                side: side,
                target: target,
                minPremium: PRICE_TICK * 10,
                size: ONE,
                flip: false,
                flipTarget: 0
            })
        );
    }

    function _bid(uint256 series, uint64 expiry) internal {
        QuoteSettlement.Quote memory q = QuoteSettlement.Quote({
            maker: maker,
            taker: address(0),
            series: series,
            premium: PREMIUM,
            maxFeeBps: 0,
            maxAmount: 5 * ONE,
            minFill: LOT,
            nonce: ++nonce,
            deadline: expiry
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, market.quoteDigest(q));
        market.submitBid(q, abi.encodePacked(r, s, v));
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    /// @dev Pings from `from`, bids at the window's opening, then each series' batch once the
    /// window has run.
    function _renew(uint64 close, uint64 expiry, uint256 from, uint256 callOrder, uint256 putOrder)
        internal
        returns (uint256 calls, uint256 puts)
    {
        calls = market.seriesFor(nvda, expiry, OptionType.Call, callTarget);
        puts = market.seriesFor(nvda, expiry, OptionType.Put, putTarget);
        _keepAlive(from, close + 2 hours);
        _bid(calls, expiry);
        _bid(puts, expiry);
        _keepAlive(close + 2 hours + 1 minutes, close + 4 hours);
        uint256[2] memory series = [calls, puts];
        uint256[2] memory orders = [callOrder, putOrder];
        for (uint256 i; i < 2; ++i) {
            market.openBatch(series[i]);
            market.countBatch(series[i], _one(orders[i]));
            market.fillBatch(series[i], _one(orders[i]));
        }
    }

    function test_standingOrdersRenewIntoTheNextWeek() public {
        // #given: week one, both orders filled by the batch
        _openWeek(SEP_25);
        uint256 sell = _order(alice, OptionType.Call, callTarget);
        uint256 buy = _order(bob, OptionType.Put, putTarget);
        (uint256 calls,) = _renew(SEP_25, OCT_02, SEP_25 + 11 minutes, sell, buy);
        assertEq(market.orderOf(sell).committed, ONE);
        assertEq(market.orderOf(buy).committed, ONE);

        // #when: at the Oct 2 close the next week opens, the maker buys half of alice's NVDA in
        // the window, week one settles, and both orders go through week two's batch
        _openWeek(OCT_02);
        _keepAlive(OCT_02 + 11 minutes, OCT_02 + 15 minutes);
        vm.prank(maker);
        market.exercise(calls, ONE / 2);
        _keepAlive(OCT_02 + 16 minutes, OCT_02 + 2 hours);
        market.finalize(calls);
        market.finalize(market.orderOf(buy).series);
        market.settleOrder(sell);
        market.settleOrder(buy);
        (uint256 nextCalls, uint256 nextPuts) = _renew(OCT_02, OCT_09, OCT_02 + 2 hours, sell, buy);

        // #then: alice's unsold half and all of bob's order are written again for the new week
        assertEq(market.orderOf(sell).series, nextCalls);
        assertEq(market.orderOf(sell).committed, ONE / 2);
        assertEq(market.orderOf(buy).series, nextPuts);
        assertEq(market.orderOf(buy).committed, ONE);
        assertEq(market.claimable(alice, usdg), PREMIUM + callTarget / 2 + PREMIUM / 2);
        assertEq(market.claimable(bob, usdg), 2 * PREMIUM);
    }
}
