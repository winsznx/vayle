// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VayleMarket} from "../../src/VayleMarket.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @dev Random interleavings of holder, maker, keeper and guardian actions on the deployable
/// market. Ghost flags record any user action that succeeded while it shouldn't have.
contract MarketHandler is Test {
    uint256 internal constant lot = 1e16;
    uint256 internal constant priceTick = 100;
    uint256 internal constant strikeTick = 5e6;

    struct Setup {
        VayleMarket market;
        LivenessCheckpoint liveness;
        address asset;
        address quoter;
        uint256 quoterKey;
        address guardian;
        uint256 callSeries;
        uint256 putSeries;
        uint256 callStrike;
        uint256 putStrike;
        uint64 expiry;
    }

    VayleMarket internal immutable market;
    LivenessCheckpoint internal immutable liveness;
    address internal immutable asset;
    address internal immutable quoter;
    uint256 internal immutable quoterKey;
    address internal immutable guardian;
    uint256 internal immutable callSeries;
    uint256 internal immutable putSeries;
    uint256 internal immutable callStrike;
    uint256 internal immutable putStrike;
    uint64 internal immutable expiry;
    address[] internal holders;
    uint256 internal nonce;

    bool public finalized;
    bool public actedWhileHalted;
    bool public grewWhilePaused;
    bool public amendMisaccounted;

    constructor(Setup memory s, address[] memory holders_) {
        (market, liveness, asset, quoter, quoterKey, guardian) =
        (s.market, s.liveness, s.asset, s.quoter, s.quoterKey, s.guardian);
        (callSeries, putSeries, callStrike, putStrike, expiry) =
        (s.callSeries, s.putSeries, s.callStrike, s.putStrike, s.expiry);
        holders = holders_;
    }

    /// @dev Called right after a user action succeeded. A revert never reaches it.
    function _acted() internal {
        if (market.haltedUntil() > vm.getBlockTimestamp()) actedWhileHalted = true;
    }

    function _paused() internal view returns (bool) {
        return market.paused() || market.assetPaused(asset);
    }

    /// @notice The targets orders move between on a side: its series' strike, a tick further out,
    /// and the other side's strike, which that side's grid never lists.
    function targets(OptionType side) public view returns (uint256[3] memory) {
        return side == OptionType.Call
            ? [callStrike, callStrike + strikeTick, putStrike]
            : [putStrike, putStrike - strikeTick, callStrike];
    }

    function _collateral(OptionType side, uint256 size, uint256 target, uint256 RAW_UNIT)
        internal
        pure
        returns (uint256)
    {
        return side == OptionType.Call ? size : Units.valueExact(size, target, RAW_UNIT);
    }

    function place(uint256 who, bool put, uint256 lots, uint256 floorTicks) external {
        address owner = holders[who % holders.length];
        OptionType side = put ? OptionType.Put : OptionType.Call;
        uint256 size = bound(lots, 1, 100) * lot;
        MarketGuard.Caps memory caps = market.capsOf(asset, side);
        if (
            market.openSize(asset, side) + size > caps.openSize
                || market.walletSize(owner, asset, side) + size > caps.walletSize
        ) return;
        CollateralVault.OrderParams memory p = CollateralVault.OrderParams({
            asset: asset,
            side: side,
            target: put ? putStrike : callStrike,
            minPremium: bound(floorTicks, 0, 1000) * priceTick,
            size: size,
            flip: false,
            flipTarget: 0
        });
        vm.prank(owner);
        market.placeOrder(p);
        _acted();
        if (_paused()) grewWhilePaused = true;
    }

    function cancel(uint256 seed) external {
        uint256 count = market.orderCount();
        if (count == 0) return;
        uint256 id = seed % count + 1;
        CollateralVault.Order memory o = market.orderOf(id);
        if (o.status != CollateralVault.OrderStatus.Active) return;
        vm.prank(o.owner);
        market.cancelOrder(id);
        _acted();
    }

    /// @dev Moves an idle order to one of its side's targets with a new size, floor and flip.
    /// Records any amend whose collateral moved by anything other than the exact difference
    /// between the old and new terms, in one direction.
    function amend(
        uint256 seed,
        uint256 targetSeed,
        uint256 lots,
        uint256 floorTicks,
        uint256 flipSeed
    ) external {
        uint256 count = market.orderCount();
        if (count == 0) return;
        uint256 id = seed % count + 1;
        CollateralVault.Order memory o = market.orderOf(id);
        if (o.status != CollateralVault.OrderStatus.Active || o.series != 0) return;
        uint256 size = bound(lots, 1, 100) * lot;
        MarketGuard.Caps memory caps = market.capsOf(asset, o.side);
        if (
            market.openSize(asset, o.side) - o.size + size > caps.openSize
                || market.walletSize(o.owner, asset, o.side) - o.size + size > caps.walletSize
        ) return;
        bool flip = flipSeed % 2 == 1;
        OptionType other = o.side == OptionType.Call ? OptionType.Put : OptionType.Call;
        CollateralVault.AmendParams memory p = CollateralVault.AmendParams({
            target: targets(o.side)[targetSeed % 3],
            minPremium: bound(floorTicks, 0, 1000) * priceTick,
            size: size,
            flip: flip,
            flipTarget: flip ? targets(other)[(flipSeed / 2) % 3] : 0
        });
        address token = o.side == OptionType.Call ? asset : market.usdg();
        int256 walletBefore = int256(IERC20(token).balanceOf(o.owner));
        int256 claimBefore = int256(market.claimable(o.owner, token));
        vm.prank(o.owner);
        market.amendOrder(id, p);
        _acted();
        if (_paused()) grewWhilePaused = true;
        int256 owed = int256(_collateral(o.side, size, p.target, o.rawUnit))
            - int256(_collateral(o.side, o.size, o.target, o.rawUnit));
        int256 pulled = walletBefore - int256(IERC20(token).balanceOf(o.owner));
        int256 credited = int256(market.claimable(o.owner, token)) - claimBefore;
        bool exact = owed >= 0 ? pulled == owed && credited == 0 : credited == -owed && pulled == 0;
        if (!exact) amendMisaccounted = true;
    }

    function fill(uint256 seed, uint256 lots, uint256 premiumTicks) external {
        uint256 count = market.orderCount();
        if (finalized || count == 0 || vm.getBlockTimestamp() >= expiry) return;
        uint256 id = seed % count + 1;
        CollateralVault.Order memory o = market.orderOf(id);
        uint256 series = o.side == OptionType.Call ? callSeries : putSeries;
        // Only the two series' strikes have quotes. An order amended elsewhere waits.
        if (o.target != (o.side == OptionType.Call ? callStrike : putStrike)) return;
        MarketGuard.Caps memory caps = market.capsOf(asset, o.side);
        uint256 room = caps.seriesOpenInterest - market.poolOf(series).written;
        uint256 maxLots = (o.size - o.committed) / lot;
        if (caps.fillSize / lot < maxLots) maxLots = caps.fillSize / lot;
        if (room / lot < maxLots) maxLots = room / lot;
        if (o.status != CollateralVault.OrderStatus.Active || maxLots == 0) return;
        uint256 amount = bound(lots, 1, maxLots) * lot;
        QuoteSettlement.Quote memory q = QuoteSettlement.Quote({
            maker: quoter,
            taker: address(0),
            series: series,
            premium: o.minPremium + bound(premiumTicks, 0, 10_000) * priceTick,
            maxFeeBps: market.feeBps(),
            maxAmount: amount,
            minFill: lot,
            nonce: ++nonce,
            deadline: expiry
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoterKey, market.quoteDigest(q));
        market.fillQuote(q, abi.encodePacked(r, s, v), id, amount);
        _acted();
        if (_paused()) grewWhilePaused = true;
    }

    /// @dev The keeper pings up to ten minutes into the exercise window.
    function toWindow() external {
        if (vm.getBlockTimestamp() >= expiry) return;
        uint256 from = vm.getBlockTimestamp() > expiry - 5 minutes
            ? vm.getBlockTimestamp()
            : expiry - 5 minutes;
        for (uint256 t = from; t <= expiry + 10 minutes; t += 1 minutes) {
            vm.warp(t);
            liveness.checkpoint();
        }
    }

    function exercise(bool put, uint256 lots) external {
        uint256 series = put ? putSeries : callSeries;
        if (
            finalized || vm.getBlockTimestamp() < expiry
                || vm.getBlockTimestamp() >= market.windowEnd(series)
        ) {
            return;
        }
        uint256 held = market.balanceOf(quoter, series) / lot;
        if (held == 0) return;
        vm.prank(quoter);
        market.exercise(series, bound(lots, 1, held) * lot);
        _acted();
    }

    /// @dev Moves past both windows, beyond the 24-hour gap budget and every halt so far.
    function finalize() external {
        if (finalized) return;
        uint256 base = vm.getBlockTimestamp() > expiry ? vm.getBlockTimestamp() : expiry;
        vm.warp(base + 27 hours + 72 hours * market.haltCount());
        market.finalize(callSeries);
        market.finalize(putSeries);
        _acted();
        finalized = true;
    }

    function settle(uint256 seed) external {
        uint256 count = market.orderCount();
        if (!finalized || count == 0) return;
        uint256 id = seed % count + 1;
        if (market.orderOf(id).series == 0) return;
        market.settleOrder(id);
        _acted();
    }

    function withdraw(uint256 who, bool usdgToken) external {
        address owner = who % 4 == 3 ? quoter : holders[who % holders.length];
        address token = usdgToken ? market.usdg() : asset;
        uint256 amount = market.claimable(owner, token);
        if (amount == 0) return;
        vm.prank(owner);
        market.withdraw(token, amount);
        _acted();
    }

    function setPaused(bool flag) external {
        vm.prank(guardian);
        market.setPaused(flag);
    }

    function halt() external {
        if (market.haltedUntil() > vm.getBlockTimestamp()) return;
        vm.prank(guardian);
        market.halt();
    }

    function endHalt() external {
        if (market.haltedUntil() <= vm.getBlockTimestamp()) return;
        vm.prank(guardian);
        market.endHalt();
    }
}

/// @notice Campaign A, stateful: every market property holds after every call.
contract MarketInvariantsForkTest is VayleMarketFork {
    MarketHandler internal handler;

    error UntrackedTarget(uint256 orderId, uint256 target);

    function setUp() public override {
        super.setUp();
        address[] memory holders = new address[](3);
        (holders[0], holders[1], holders[2]) = (alice, bob, carol);
        handler = new MarketHandler(
            MarketHandler.Setup({
                market: market,
                liveness: liveness,
                asset: stock,
                quoter: quoter,
                quoterKey: quoterKey,
                guardian: guardian,
                callSeries: callSeries,
                putSeries: putSeries,
                callStrike: callStrike,
                putStrike: putStrike,
                expiry: OCT_09
            }),
            holders
        );
        targetContract(address(handler));
        // One local sender, so the fuzzer never asks the fork for unknown accounts.
        address keeper = makeAddr("keeper");
        vm.deal(keeper, 1 ether);
        targetSender(keeper);
    }

    /// @dev All market properties in one campaign, which keeps fork traffic to a single setUp.
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 40
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 64
    function invariant_market() public view {
        _assertConserved(_claimants());
        _assertSizesTracked();
        _assertBucketsTracked();
        _assertSeriesBacked();
        _assertWithinCaps();
        assertFalse(handler.actedWhileHalted(), "a user action succeeded during a halt");
        assertFalse(handler.grewWhilePaused(), "a placement or fill succeeded during a pause");
        assertFalse(handler.amendMisaccounted(), "an amend moved other than the difference");
    }

    /// @dev Every order sits in one of the handler's buckets. Each bucket's idle size is the sum
    /// over its active orders that aren't written into a series, and its attached count is the
    /// number of its orders that are. So no order's size is counted in two buckets, or in none.
    function _assertBucketsTracked() internal view {
        for (uint256 side; side < 2; ++side) {
            uint256[3] memory targets = handler.targets(OptionType(side));
            uint256[3] memory idle;
            uint256[3] memory attached;
            for (uint256 id = 1; id <= market.orderCount(); ++id) {
                CollateralVault.Order memory o = market.orderOf(id);
                if (uint256(o.side) != side) continue;
                uint256 t = _bucketOf(targets, id, o.target);
                if (o.series != 0) ++attached[t];
                else if (o.status == CollateralVault.OrderStatus.Active) idle[t] += o.size;
            }
            for (uint256 t; t < 3; ++t) {
                OptionType s = OptionType(side);
                assertEq(market.idleSize(stock, s, targets[t]), idle[t], "idle size per bucket");
                assertEq(market.attachedOrders(stock, s, targets[t]), attached[t], "attached");
            }
        }
    }

    function _bucketOf(uint256[3] memory targets, uint256 id, uint256 target)
        internal
        pure
        returns (uint256 t)
    {
        for (; t < 3; ++t) {
            if (targets[t] == target) return t;
        }
        revert UntrackedTarget(id, target);
    }

    function _assertSizesTracked() internal view {
        address[3] memory owners = [alice, bob, carol];
        uint256[2] memory open;
        uint256[2][3] memory wallet;
        for (uint256 id = 1; id <= market.orderCount(); ++id) {
            CollateralVault.Order memory o = market.orderOf(id);
            assertEq(o.size % lot, 0, "whole lots");
            assertLe(o.committed, o.size, "committed within size");
            if (o.status == CollateralVault.OrderStatus.Closed) continue;
            uint256 side = uint256(o.side);
            open[side] += o.size;
            for (uint256 h; h < owners.length; ++h) {
                if (owners[h] == o.owner) wallet[h][side] += o.size;
            }
        }
        for (uint256 side; side < 2; ++side) {
            assertEq(market.openSize(stock, OptionType(side)), open[side], "open size");
            for (uint256 h; h < owners.length; ++h) {
                assertEq(market.walletSize(owners[h], stock, OptionType(side)), wallet[h][side]);
            }
        }
    }

    function _assertSeriesBacked() internal view {
        CollateralVault.Pool memory c = market.poolOf(callSeries);
        CollateralVault.Pool memory p = market.poolOf(putSeries);
        assertLe(c.exercised, c.written);
        assertLe(p.exercised, p.written);
        if (handler.finalized()) return;
        assertEq(c.collateral, c.written - c.exercised, "calls backed");
        assertEq(market.totalSupply(callSeries), c.written - c.exercised, "call supply");
        assertEq(
            p.collateral,
            Units.valueExact(p.written - p.exercised, putStrike, RAW_UNIT),
            "puts backed"
        );
        assertEq(market.totalSupply(putSeries), p.written - p.exercised, "put supply");
    }

    function _assertWithinCaps() internal view {
        for (uint256 side; side < 2; ++side) {
            MarketGuard.Caps memory caps = market.capsOf(stock, OptionType(side));
            uint256 series = side == uint256(OptionType.Call) ? callSeries : putSeries;
            assertLe(market.poolOf(series).written, caps.seriesOpenInterest, "series cap");
            assertLe(market.openSize(stock, OptionType(side)), caps.openSize, "open size cap");
        }
    }
}
