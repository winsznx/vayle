// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {VaultHarness} from "../core/VaultHarness.sol";
import {VaultFork} from "../utils/VaultFork.sol";

/// @dev Random sequences of holder and settlement actions against the real tokens.
contract VaultHandler is Test {
    uint256 internal constant LOT = 1e16;

    VaultHarness internal immutable vault;
    uint256 internal immutable callSeries;
    uint256 internal immutable putSeries;
    uint256 internal immutable callStrike;
    uint256 internal immutable putStrike;
    uint64 internal immutable expiry;
    address internal immutable maker;
    address[] internal holders;

    bool public finalized;

    constructor(
        VaultHarness vault_,
        uint256[4] memory series,
        uint64 expiry_,
        address maker_,
        address[] memory holders_
    ) {
        vault = vault_;
        (callSeries, putSeries, callStrike, putStrike) =
        (series[0], series[1], series[2], series[3]);
        expiry = expiry_;
        maker = maker_;
        holders = holders_;
    }

    function place(uint256 who, bool put, uint256 lots, uint256 premiumTicks) external {
        address owner = holders[who % holders.length];
        lots = bound(lots, 1, 300);
        CollateralVault.OrderParams memory p = CollateralVault.OrderParams({
            asset: vault.seriesKey(callSeries).asset,
            side: put ? OptionType.Put : OptionType.Call,
            target: put ? putStrike : callStrike,
            minPremium: bound(premiumTicks, 0, 1000) * 100,
            size: lots * LOT,
            flip: false,
            flipTarget: 0
        });
        vm.prank(owner);
        vault.placeOrder(p);
    }

    function cancel(uint256 seed) external {
        uint256 count = vault.orderCount();
        if (count == 0) return;
        uint256 id = seed % count + 1;
        CollateralVault.Order memory o = vault.orderOf(id);
        if (o.status != CollateralVault.OrderStatus.Active) return;
        vm.prank(o.owner);
        vault.cancelOrder(id);
    }

    function fill(uint256 seed, uint256 lots) external {
        uint256 count = vault.orderCount();
        if (finalized || count == 0) return;
        uint256 id = seed % count + 1;
        CollateralVault.Order memory o = vault.orderOf(id);
        uint256 uncommittedLots = (o.size - o.committed) / LOT;
        if (o.status != CollateralVault.OrderStatus.Active || uncommittedLots == 0) return;
        uint256 series = o.side == OptionType.Call ? callSeries : putSeries;
        vault.fill(id, series, bound(lots, 1, uncommittedLots) * LOT, maker);
    }

    function exercise(bool put, uint256 lots) external {
        if (finalized) return;
        uint256 series = put ? putSeries : callSeries;
        uint256 heldLots = vault.balanceOf(maker, series) / LOT;
        if (heldLots == 0) return;
        vault.exercise(series, bound(lots, 1, heldLots) * LOT, maker);
    }

    function finalize() external {
        if (finalized) return;
        vm.warp(expiry + 3 hours);
        vault.finalize(callSeries);
        vault.finalize(putSeries);
        finalized = true;
    }

    function settle(uint256 seed) external {
        uint256 count = vault.orderCount();
        if (!finalized || count == 0) return;
        uint256 id = seed % count + 1;
        if (vault.orderOf(id).series == 0) return;
        vault.settleOrder(id);
    }

    function withdraw(uint256 who, bool usdgToken) external {
        address owner = who % 2 == 0 ? maker : holders[who % holders.length];
        address token = usdgToken ? vault.usdg() : vault.seriesKey(callSeries).asset;
        uint256 amount = vault.claimable(owner, token);
        if (amount == 0) return;
        vm.prank(owner);
        vault.withdraw(token, amount);
    }
}

contract VaultInvariantsForkTest is VaultFork {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory holders = new address[](3);
        (holders[0], holders[1], holders[2]) = (alice, bob, carol);
        handler = new VaultHandler(
            vault, [callSeries, putSeries, callStrike, putStrike], OCT_09, maker, holders
        );
        targetContract(address(handler));
        // One local sender, so the fuzzer never asks the fork for unknown accounts.
        address keeper = makeAddr("keeper");
        vm.deal(keeper, 1 ether);
        targetSender(keeper);
    }

    /// @dev All vault properties in one campaign, which keeps fork traffic to a single setUp.
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 40
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 64
    function invariant_vault() public view {
        _assertConserved(_everyone());
        _assertSeriesBacked();
        _assertSettledPoolsEmpty();
        _assertOrdersWholeLots();
    }

    function _assertSeriesBacked() internal view {
        CollateralVault.Pool memory c = vault.poolOf(callSeries);
        CollateralVault.Pool memory p = vault.poolOf(putSeries);
        assertLe(c.exercised, c.written);
        assertLe(p.exercised, p.written);
        if (handler.finalized()) return;
        assertEq(c.collateral, c.written - c.exercised);
        assertEq(vault.totalSupply(callSeries), c.written - c.exercised);
        assertEq(p.collateral, Units.valueExact(p.written - p.exercised, putStrike, RAW_UNIT));
        assertEq(vault.totalSupply(putSeries), p.written - p.exercised);
    }

    function _assertSettledPoolsEmpty() internal view {
        if (!handler.finalized()) return;
        for (uint256 id = 1; id <= vault.orderCount(); ++id) {
            if (vault.orderOf(id).series != 0) return;
        }
        CollateralVault.Pool memory c = vault.poolOf(callSeries);
        CollateralVault.Pool memory p = vault.poolOf(putSeries);
        assertEq(c.collateral + c.proceeds + c.remainingShares, 0);
        assertEq(p.collateral + p.proceeds + p.remainingShares, 0);
    }

    function _assertOrdersWholeLots() internal view {
        for (uint256 id = 1; id <= vault.orderCount(); ++id) {
            CollateralVault.Order memory o = vault.orderOf(id);
            assertEq(o.size % LOT, 0);
            assertLe(o.committed, o.size);
        }
    }
}
