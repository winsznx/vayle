// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {ChainActors, IOracleAdmin} from "../utils/ChainActors.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

interface IMultiplierAdmin {
    function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt) external;
    function uiMultiplier() external view returns (uint256);
}

interface IPausableRegistry {
    function pause() external;
    function unpause() external;
}

/// @notice Campaign D, corporate actions, through the real issuer roles on real NVDA. Obligations
/// are in raw token units, which no multiplier change touches, so every entitlement must survive.
contract CorporateActionsForkTest is VayleMarketFork {
    uint256 internal callOrder;
    uint256 internal putOrder;

    function setUp() public override {
        super.setUp();
        callOrder = _writeCall(alice, ONE);
        putOrder = _place(bob, OptionType.Put, ONE);
        _fillQuote(putOrder, putSeries, ONE);
    }

    function _setMultiplier(uint256 multiplier, uint256 effectiveAt) internal {
        vm.prank(ChainActors.MULTIPLIER_UPDATER);
        IMultiplierAdmin(nvda).updateMultiplier(multiplier, effectiveAt);
    }

    /// @dev The maker exercises everything, the series settle, and both holders withdraw.
    function _settleTheWeek() internal {
        _intoTheWindow();
        vm.startPrank(quoter);
        market.exercise(callSeries, ONE);
        market.exercise(putSeries, ONE);
        vm.stopPrank();
        _pastTheWindow();
        market.finalize(callSeries);
        market.finalize(putSeries);
        market.settleOrder(callOrder);
        market.settleOrder(putOrder);
    }

    /// @dev Alice sold one raw NVDA at the call strike and bob bought one at the put strike, each
    /// keeping the premium, whatever the multiplier did in between.
    function _assertRawEntitlements() internal view {
        assertEq(market.claimable(alice, usdg), PREMIUM + _value(ONE, callStrike), "alice USDG");
        assertEq(market.claimable(bob, nvda), ONE, "bob NVDA");
        assertEq(market.claimable(bob, usdg), PREMIUM, "bob premium");
        assertEq(market.claimable(quoter, nvda), ONE, "maker NVDA");
        assertEq(market.claimable(quoter, usdg), _value(ONE, putStrike), "maker USDG");
        _assertConserved(_claimants());
    }

    function test_aTwoForOneSplitMidWeekPreservesEveryEntitlement() public {
        // #given
        _setMultiplier(IMultiplierAdmin(nvda).uiMultiplier() * 2, block.timestamp);
        // #when
        _settleTheWeek();
        // #then
        _assertRawEntitlements();
    }

    function test_aReverseSplitMidWeekPreservesEveryEntitlement() public {
        // #given
        _setMultiplier(IMultiplierAdmin(nvda).uiMultiplier() / 2, block.timestamp);
        // #when
        _settleTheWeek();
        // #then
        _assertRawEntitlements();
    }

    function test_aMultiplierChangeInsideTheWindowSplitsNoExercise() public {
        // #given: a 4-for-1 staged ten minutes ahead, half the longs exercised on each side of it
        _keepAlive(OCT_09 - 5 minutes, OCT_09 + 5 minutes);
        _setMultiplier(IMultiplierAdmin(nvda).uiMultiplier() * 4, OCT_09 + 15 minutes);
        vm.startPrank(quoter);
        market.exercise(callSeries, ONE / 2);
        market.exercise(putSeries, ONE / 2);
        vm.stopPrank();
        _keepAlive(OCT_09 + 6 minutes, OCT_09 + 30 minutes);
        // #when
        vm.startPrank(quoter);
        market.exercise(callSeries, ONE / 2);
        market.exercise(putSeries, ONE / 2);
        vm.stopPrank();
        _pastTheWindow();
        market.finalize(callSeries);
        market.finalize(putSeries);
        market.settleOrder(callOrder);
        market.settleOrder(putOrder);
        // #then
        _assertRawEntitlements();
    }

    function test_anIssuerPauseInTheWindowDelaysButDoesntCostTheExercise() public {
        // #given: every Stock Token paused an hour into the window, for four hours
        _keepAlive(OCT_09 - 5 minutes, OCT_09 + 1 hours);
        vm.prank(ChainActors.REGISTRY_PAUSER);
        IPausableRegistry(nvdaAccessRegistry).pause();
        _keepWatching(OCT_09 + 1 hours + 1 minutes, OCT_09 + 5 hours);
        vm.prank(ChainActors.REGISTRY_PAUSER);
        IPausableRegistry(nvdaAccessRegistry).unpause();
        _keepWatching(OCT_09 + 5 hours + 1 minutes, OCT_09 + 5 hours + 30 minutes);
        // #when: two hours of window are long gone by the clock, but not by live time
        vm.prank(quoter);
        market.exercise(putSeries, ONE);
        // #then
        assertEq(market.claimable(quoter, usdg), _value(ONE, putStrike));
    }

    function test_delistingMakesTheAssetSettlementOnly() public {
        // #given: a fresh order and quote, then the admin delists NVDA mid-week
        uint256 id = _place(carol, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.prank(admin);
        registry.delist(nvda);
        // #then: nothing new is written
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, nvda));
        market.fillQuote(q, sig, id, ONE);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, nvda));
        _place(carol, OptionType.Call, ONE);
        // #when: the live series still settle in full
        vm.prank(carol);
        market.cancelOrder(id);
        _settleTheWeek();
        // #then
        _assertRawEntitlements();
    }

    function test_anOraclePauseRefusesFillsButNoExit() public {
        // #given
        uint256 id = _place(carol, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.prank(ChainActors.ORACLE_PAUSER);
        IOracleAdmin(nvda).pauseOracle();
        // #then
        vm.expectRevert(abi.encodeWithSelector(MarketGuard.OraclePaused.selector, nvda));
        market.fillQuote(q, sig, id, ONE);
        // #when
        vm.prank(carol);
        market.cancelOrder(id);
        _settleTheWeek();
        // #then
        _assertRawEntitlements();
    }

    /// @dev The keeper's window schedule: liveness pings and issuer pause observations.
    function _keepWatching(uint256 from, uint256 to) internal {
        for (uint256 t = from; t <= to; t += 1 minutes) {
            vm.warp(t);
            liveness.checkpoint();
            market.observePauses(nvda);
        }
    }
}
