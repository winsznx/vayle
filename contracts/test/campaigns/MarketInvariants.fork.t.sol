// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
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
    uint256 internal constant LOT = 1e16;
    uint256 internal constant PRICE_TICK = 100;

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

    constructor(Setup memory s, address[] memory holders_) {
        (market, liveness, asset, quoter, quoterKey, guardian) =
        (s.market, s.liveness, s.asset, s.quoter, s.quoterKey, s.guardian);
        (callSeries, putSeries, callStrike, putStrike, expiry) =
        (s.callSeries, s.putSeries, s.callStrike, s.putStrike, s.expiry);
        holders = holders_;
    }

    /// @dev Called right after a user action succeeded. A revert never reaches it.
    function _acted() internal {
        if (market.haltedUntil() > block.timestamp) actedWhileHalted = true;
    }

    function _paused() internal view returns (bool) {
        return market.paused() || market.assetPaused(asset);
    }

    function place(uint256 who, bool put, uint256 lots, uint256 floorTicks) external {
        address owner = holders[who % holders.length];
        OptionType side = put ? OptionType.Put : OptionType.Call;
        uint256 size = bound(lots, 1, 100) * LOT;
        MarketGuard.Caps memory caps = market.capsOf(asset, side);
        if (
            market.openSize(asset, side) + size > caps.openSize
                || market.walletSize(owner, asset, side) + size > caps.walletSize
        ) return;
        CollateralVault.OrderParams memory p = CollateralVault.OrderParams({
            asset: asset,
            side: side,
            target: put ? putStrike : callStrike,
            minPremium: bound(floorTicks, 0, 1000) * PRICE_TICK,
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

    function fill(uint256 seed, uint256 lots, uint256 premiumTicks) external {
        uint256 count = market.orderCount();
        if (finalized || count == 0 || block.timestamp >= expiry) return;
        uint256 id = seed % count + 1;
        CollateralVault.Order memory o = market.orderOf(id);
        uint256 series = o.side == OptionType.Call ? callSeries : putSeries;
        MarketGuard.Caps memory caps = market.capsOf(asset, o.side);
        uint256 room = caps.seriesOpenInterest - market.poolOf(series).written;
        uint256 maxLots = (o.size - o.committed) / LOT;
        if (caps.fillSize / LOT < maxLots) maxLots = caps.fillSize / LOT;
        if (room / LOT < maxLots) maxLots = room / LOT;
        if (o.status != CollateralVault.OrderStatus.Active || maxLots == 0) return;
        uint256 amount = bound(lots, 1, maxLots) * LOT;
        QuoteSettlement.Quote memory q = QuoteSettlement.Quote({
            maker: quoter,
            taker: address(0),
            series: series,
            premium: o.minPremium + bound(premiumTicks, 0, 10_000) * PRICE_TICK,
            maxFeeBps: market.feeBps(),
            maxAmount: amount,
            minFill: LOT,
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
        if (block.timestamp >= expiry) return;
        uint256 from = block.timestamp > expiry - 5 minutes ? block.timestamp : expiry - 5 minutes;
        for (uint256 t = from; t <= expiry + 10 minutes; t += 1 minutes) {
            vm.warp(t);
            liveness.checkpoint();
        }
    }

    function exercise(bool put, uint256 lots) external {
        uint256 series = put ? putSeries : callSeries;
        if (finalized || block.timestamp < expiry || block.timestamp >= market.windowEnd(series)) {
            return;
        }
        uint256 held = market.balanceOf(quoter, series) / LOT;
        if (held == 0) return;
        vm.prank(quoter);
        market.exercise(series, bound(lots, 1, held) * LOT);
        _acted();
    }

    /// @dev Moves past both windows, beyond the 24-hour gap budget and every halt so far.
    function finalize() external {
        if (finalized) return;
        uint256 base = block.timestamp > expiry ? block.timestamp : expiry;
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
        if (market.haltedUntil() > block.timestamp) return;
        vm.prank(guardian);
        market.halt();
    }

    function endHalt() external {
        if (market.haltedUntil() <= block.timestamp) return;
        vm.prank(guardian);
        market.endHalt();
    }
}

/// @notice Campaign A, stateful: every market property holds after every call.
contract MarketInvariantsForkTest is VayleMarketFork {
    MarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory holders = new address[](3);
        (holders[0], holders[1], holders[2]) = (alice, bob, carol);
        handler = new MarketHandler(
            MarketHandler.Setup({
                market: market,
                liveness: liveness,
                asset: nvda,
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
        _assertSeriesBacked();
        _assertWithinCaps();
        assertFalse(handler.actedWhileHalted(), "a user action succeeded during a halt");
        assertFalse(handler.grewWhilePaused(), "a placement or fill succeeded during a pause");
    }

    function _assertSizesTracked() internal view {
        address[3] memory owners = [alice, bob, carol];
        uint256[2] memory open;
        uint256[2][3] memory wallet;
        for (uint256 id = 1; id <= market.orderCount(); ++id) {
            CollateralVault.Order memory o = market.orderOf(id);
            assertEq(o.size % LOT, 0, "whole lots");
            assertLe(o.committed, o.size, "committed within size");
            if (o.status == CollateralVault.OrderStatus.Closed) continue;
            uint256 side = uint256(o.side);
            open[side] += o.size;
            for (uint256 h; h < owners.length; ++h) {
                if (owners[h] == o.owner) wallet[h][side] += o.size;
            }
        }
        for (uint256 side; side < 2; ++side) {
            assertEq(market.openSize(nvda, OptionType(side)), open[side], "open size");
            for (uint256 h; h < owners.length; ++h) {
                assertEq(market.walletSize(owners[h], nvda, OptionType(side)), wallet[h][side]);
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
            MarketGuard.Caps memory caps = market.capsOf(nvda, OptionType(side));
            uint256 series = side == uint256(OptionType.Call) ? callSeries : putSeries;
            assertLe(market.poolOf(series).written, caps.seriesOpenInterest, "series cap");
            assertLe(market.openSize(nvda, OptionType(side)), caps.openSize, "open size cap");
        }
    }
}
