// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {VaultFork} from "../utils/VaultFork.sol";

interface IMultiplierAdmin {
    function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt) external;
    function uiMultiplier() external view returns (uint256);
}

contract CollateralVaultForkTest is VaultFork {
    uint256 internal constant ONE = 1e18;

    function test_aSellOrderLocksTheRawTokens() public {
        // #given
        uint256 before = IERC20(stock).balanceOf(alice);
        // #when
        uint256 id = _place(alice, OptionType.Call, 2 * ONE);
        // #then
        CollateralVault.Order memory o = vault.orderOf(id);
        assertEq(IERC20(stock).balanceOf(alice), before - 2 * ONE);
        assertEq(o.size, 2 * ONE);
        assertEq(uint8(o.status), uint8(CollateralVault.OrderStatus.Active));
        _assertConserved(_everyone());
    }

    function test_aBuyOrderLocksTheExactUsdgValueAtItsTarget() public {
        // #given
        uint256 before = IERC20(usdg).balanceOf(bob);
        // #when
        _place(bob, OptionType.Put, 3 * lot);
        // #then
        assertEq(IERC20(usdg).balanceOf(bob), before - _value(3 * lot, putStrike));
        _assertConserved(_everyone());
    }

    function test_refusesASizeThatIsntWholeLots() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotALot.selector, lot + 1, lot));
        // #when
        vm.prank(alice);
        vault.placeOrder(_params(OptionType.Call, callStrike, lot + 1));
    }

    function test_refusesATargetOffTheStrikeTickOrZero() public {
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Units.NotOnTick.selector, callStrike + 1, strikeTick)
        );
        // #when
        vm.prank(alice);
        vault.placeOrder(_params(OptionType.Call, callStrike + 1, lot));
        // #then
        vm.expectRevert(Units.ZeroAmount.selector);
        // #when
        vm.prank(alice);
        vault.placeOrder(_params(OptionType.Call, 0, lot));
    }

    function test_refusesAMinimumPremiumOffThePriceTick() public {
        // #given
        CollateralVault.OrderParams memory p = _params(OptionType.Call, callStrike, lot);
        p.minPremium = priceTick + 1;
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotOnTick.selector, priceTick + 1, priceTick));
        // #when
        vm.prank(alice);
        vault.placeOrder(p);
    }

    function test_cancellingReleasesUncommittedCollateralToClaimable() public {
        // #given
        uint256 id = _place(alice, OptionType.Put, 4 * lot);
        // #when
        vm.prank(alice);
        vault.cancelOrder(id);
        // #then
        assertEq(vault.claimable(alice, usdg), _value(4 * lot, putStrike));
        assertEq(uint8(vault.orderOf(id).status), uint8(CollateralVault.OrderStatus.Closed));
        _assertConserved(_everyone());
    }

    function test_onlyTheOwnerCanCancelOrUpdate() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, lot);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotOrderOwner.selector, id, bob));
        // #when
        vm.prank(bob);
        vault.cancelOrder(id);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotOrderOwner.selector, id, bob));
        // #when
        vm.prank(bob);
        vault.updateOrder(id, priceTick, false, 0);
    }

    function test_aCancelledOrderCantBeCancelledOrUpdatedAgain() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, lot);
        vm.prank(alice);
        vault.cancelOrder(id);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.OrderNotActive.selector, id));
        // #when
        vm.prank(alice);
        vault.cancelOrder(id);
    }

    function test_updatingChangesOnlyThePremiumFloorAndFlipSettings() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, lot);
        uint256 flipTarget = putStrike;
        // #when
        vm.prank(alice);
        vault.updateOrder(id, 50 * priceTick, true, flipTarget);
        // #then
        CollateralVault.Order memory o = vault.orderOf(id);
        assertEq(o.minPremium, 50 * priceTick);
        assertTrue(o.flip);
        assertEq(o.flipTarget, flipTarget);
        assertEq(o.target, callStrike);
        assertEq(o.size, lot);
    }

    function test_withdrawPaysOutClaimableBalanceAndNoMore() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, 2 * lot);
        vm.prank(alice);
        vault.cancelOrder(id);
        uint256 before = IERC20(stock).balanceOf(alice);
        // #when
        vm.prank(alice);
        vault.withdraw(stock, 2 * lot);
        // #then
        assertEq(IERC20(stock).balanceOf(alice), before + 2 * lot);
        assertEq(vault.claimable(alice, stock), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.InsufficientClaimable.selector, alice, stock, 1, 0
            )
        );
        vm.prank(alice);
        vault.withdraw(stock, 1);
    }

    function test_aFillMustUseTheOrdersOwnSeries() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, lot);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.SeriesMismatch.selector, id, putSeries)
        );
        // #when
        vault.fill(id, putSeries, lot, maker);
    }

    function test_aFillCantExceedTheUncommittedSize() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, 2 * lot);
        vault.fill(id, callSeries, lot, maker);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.ExceedsUncommitted.selector, id, 2 * lot, lot)
        );
        // #when
        vault.fill(id, callSeries, 2 * lot, maker);
    }

    function test_aFillAfterExpiryIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, lot);
        vm.warp(OCT_09);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.SeriesClosed.selector, callSeries));
        // #when
        vault.fill(id, callSeries, lot, maker);
    }

    function test_aPartlyExercisedCallSettlesProRataAndRenewsWholeLots() public {
        // #given: alice writes 1 and bob writes 3; the maker exercises 2 of 4
        uint256 a = _place(alice, OptionType.Call, ONE);
        uint256 b = _place(bob, OptionType.Call, 3 * ONE);
        vault.fill(a, callSeries, ONE, maker);
        vault.fill(b, callSeries, 3 * ONE, maker);
        vault.exercise(callSeries, 2 * ONE, maker);
        vault.finalize(callSeries);
        // #when
        vault.settleOrder(a);
        vault.settleOrder(b);
        // #then
        assertEq(vault.claimable(alice, usdg), _value(ONE / 2, callStrike));
        assertEq(vault.claimable(bob, usdg), _value(3 * ONE / 2, callStrike));
        assertEq(vault.orderOf(a).size, ONE / 2);
        assertEq(vault.orderOf(b).size, 3 * ONE / 2);
        assertEq(vault.claimable(maker, stock), 2 * ONE);
        CollateralVault.Pool memory p = vault.poolOf(callSeries);
        assertEq(p.collateral + p.proceeds + p.remainingShares, 0);
        _assertConserved(_everyone());
    }

    function test_aPutExerciseDeliversTheAssetAndClosesAFullyFilledOrder() public {
        // #given
        uint256 id = _place(bob, OptionType.Put, ONE);
        vault.fill(id, putSeries, ONE, maker);
        // #when
        vault.exercise(putSeries, ONE, maker);
        vault.finalize(putSeries);
        vault.settleOrder(id);
        // #then
        assertEq(vault.claimable(bob, stock), ONE);
        assertEq(vault.claimable(maker, usdg), _value(ONE, putStrike));
        assertEq(uint8(vault.orderOf(id).status), uint8(CollateralVault.OrderStatus.Closed));
        _assertConserved(_everyone());
    }

    function test_unexercisedCollateralRenewsInFull() public {
        // #given
        uint256 id = _place(alice, OptionType.Put, 5 * lot);
        vault.fill(id, putSeries, 5 * lot, maker);
        vault.finalize(putSeries);
        // #when
        vault.settleOrder(id);
        // #then
        CollateralVault.Order memory o = vault.orderOf(id);
        assertEq(o.size, 5 * lot);
        assertEq(o.committed, 0);
        assertEq(o.series, 0);
        assertEq(vault.claimable(alice, usdg), 0);
        _assertConserved(_everyone());
    }

    function test_aCancelledOrdersCommittedPartIsReleasedAtSettlement() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, 3 * lot);
        vault.fill(id, callSeries, 2 * lot, maker);
        vm.prank(alice);
        vault.cancelOrder(id);
        vault.finalize(callSeries);
        // #when
        vault.settleOrder(id);
        // #then
        assertEq(vault.claimable(alice, stock), 3 * lot);
        assertEq(uint8(vault.orderOf(id).status), uint8(CollateralVault.OrderStatus.Closed));
        _assertConserved(_everyone());
    }

    function test_subLotRemaindersAreReleasedAndTheLastSettlerTakesTheRest() public {
        // #given: one lot and two lots written; one lot exercised
        uint256 a = _place(alice, OptionType.Call, lot);
        uint256 b = _place(bob, OptionType.Call, 2 * lot);
        vault.fill(a, callSeries, lot, maker);
        vault.fill(b, callSeries, 2 * lot, maker);
        vault.exercise(callSeries, lot, maker);
        vault.finalize(callSeries);
        // #when
        vault.settleOrder(a);
        vault.settleOrder(b);
        // #then: alice's two-thirds of a lot can't renew, bob's remainder renews one lot
        uint256 aliceBack = (2 * lot) / 3;
        assertEq(vault.orderOf(a).size, 0);
        assertEq(vault.claimable(alice, stock), aliceBack);
        assertEq(vault.orderOf(b).size, lot);
        assertEq(vault.claimable(bob, stock), 2 * lot - aliceBack - lot);
        assertEq(vault.claimable(alice, usdg) + vault.claimable(bob, usdg), _value(lot, callStrike));
        _assertConserved(_everyone());
    }

    function test_settlingBeforeTheSeriesSettlesOrWithNothingCommittedIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, lot);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToSettle.selector, id));
        // #when
        vault.settleOrder(id);
        // #given
        vault.fill(id, callSeries, lot, maker);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.SeriesNotSettled.selector, callSeries)
        );
        // #when
        vault.settleOrder(id);
    }

    function test_exerciseCantExceedOutstandingOrFollowFinalization() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, lot);
        vault.fill(id, callSeries, lot, maker);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.ExceedsWritten.selector, callSeries, 2 * lot, lot
            )
        );
        // #when
        vault.exercise(callSeries, 2 * lot, maker);
        // #given
        vault.finalize(callSeries);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.SeriesSettled.selector, callSeries));
        // #when
        vault.exercise(callSeries, lot, maker);
    }

    function test_aMultiplierChangeLeavesOrdersPoolsAndClaimsUntouched() public {
        // #given: orders written into both series
        uint256 a = _place(alice, OptionType.Call, ONE);
        uint256 b = _place(bob, OptionType.Put, ONE);
        vault.fill(a, callSeries, ONE / 2, maker);
        vault.fill(b, putSeries, ONE / 2, maker);
        CollateralVault.Pool memory callBefore = vault.poolOf(callSeries);
        CollateralVault.Pool memory putBefore = vault.poolOf(putSeries);
        uint256 multiplier = IMultiplierAdmin(stock).uiMultiplier();
        // #when: the real updater applies a 4-for-1 split immediately
        vm.prank(ChainActors.MULTIPLIER_UPDATER);
        IMultiplierAdmin(stock).updateMultiplier(multiplier * 4, vm.getBlockTimestamp());
        // #then
        assertEq(IMultiplierAdmin(stock).uiMultiplier(), multiplier * 4);
        assertEq(abi.encode(vault.poolOf(callSeries)), abi.encode(callBefore));
        assertEq(abi.encode(vault.poolOf(putSeries)), abi.encode(putBefore));
        assertEq(vault.orderOf(a).size, ONE);
        assertEq(vault.orderOf(b).size, ONE);
        _assertConserved(_everyone());
    }
}
