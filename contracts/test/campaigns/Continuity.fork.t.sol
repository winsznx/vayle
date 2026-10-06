// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice Campaign E at the contract level: with no keeper, watcher, maker service, indexer or
/// app, holders and the maker settle and exit through contract calls and logs alone.
contract ContinuityForkTest is VayleMarketFork {
    bytes32 internal constant ORDER_PLACED = keccak256(
        "OrderPlaced(uint256,address,address,uint8,uint256,uint256,uint256,bool,uint256)"
    );

    uint256 internal callOrder;
    uint256 internal putOrder;

    function setUp() public override {
        super.setUp();
        vm.recordLogs();
        callOrder = _writeCall(alice, ONE);
        putOrder = _place(alice, OptionType.Put, ONE);
        _fillQuote(putOrder, putSeries, ONE / 2);
    }

    /// @dev Order IDs for `owner`, read from OrderPlaced logs: owner is the second indexed topic.
    function _ordersFromLogs(Vm.Log[] memory logs, address owner)
        internal
        view
        returns (uint256[] memory ids)
    {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (_placedBy(logs[i], owner)) ++count;
        }
        ids = new uint256[](count);
        count = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (_placedBy(logs[i], owner)) ids[count++] = uint256(logs[i].topics[1]);
        }
    }

    function _placedBy(Vm.Log memory log, address owner) internal view returns (bool) {
        return log.emitter == address(market) && log.topics[0] == ORDER_PLACED
            && address(uint160(uint256(log.topics[2]))) == owner;
    }

    function test_withNoKeeperTheMakerStillExercisesInAWindowNobodyPinged() public {
        // #given: nothing has called the market since the fills a week ago
        vm.warp(OCT_09 + 1 hours);
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        // #then
        assertEq(market.claimable(quoter, nvda), ONE);
    }

    function test_aHolderExitsUsingOnlyLogsAndViews() public {
        // #given: the holder knows only their address and the market's
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256[] memory ids = _ordersFromLogs(logs, alice);
        vm.warp(OCT_09 + 30 hours);
        // #when: for each order, settle its series if it's over, cancel what's left, withdraw
        for (uint256 i; i < ids.length; ++i) {
            CollateralVault.Order memory o = market.orderOf(ids[i]);
            if (o.series != 0) {
                if (!market.poolOf(o.series).settled) market.finalize(o.series);
                market.settleOrder(ids[i]);
            }
            if (market.orderOf(ids[i]).status == CollateralVault.OrderStatus.Active) {
                vm.prank(alice);
                market.cancelOrder(ids[i]);
            }
        }
        vm.startPrank(alice);
        market.withdraw(nvda, market.claimable(alice, nvda));
        market.withdraw(usdg, market.claimable(alice, usdg));
        vm.stopPrank();
        // #then
        assertEq(ids.length, 2);
        assertEq(market.claimable(alice, nvda) + market.claimable(alice, usdg), 0);
        _assertConserved(_claimants());
    }

    function test_aStrangerCanFinalizeAndSettleForAHolder() public {
        // #given
        address stranger = makeAddr("stranger");
        vm.warp(OCT_09 + 30 hours);
        // #when
        vm.startPrank(stranger);
        market.finalize(callSeries);
        market.settleOrder(callOrder);
        vm.stopPrank();
        // #then
        assertEq(market.orderOf(callOrder).committed, 0);
        assertEq(market.claimable(alice, nvda), 0);
        assertEq(market.orderOf(callOrder).size, ONE);
    }

    function test_everyExitWorksWithAPauseThatNobodyCanLift() public {
        // #given: the guardian pauses and then loses its key
        vm.prank(guardian);
        market.setPaused(true);
        vm.warp(OCT_09 + 1 hours);
        vm.prank(quoter);
        market.exercise(putSeries, ONE / 2);
        vm.warp(OCT_09 + 30 hours);
        // #when
        market.finalize(callSeries);
        market.finalize(putSeries);
        market.settleOrder(callOrder);
        market.settleOrder(putOrder);
        vm.startPrank(alice);
        market.cancelOrder(callOrder);
        market.cancelOrder(putOrder);
        market.withdraw(nvda, market.claimable(alice, nvda));
        market.withdraw(usdg, market.claimable(alice, usdg));
        vm.stopPrank();
        // #then
        assertEq(market.openSize(nvda, OptionType.Call) + market.openSize(nvda, OptionType.Put), 0);
        _assertConserved(_claimants());
    }
}
