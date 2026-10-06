// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice Campaign A, standard lifecycle: every fuzz run is a whole week on real NVDA and USDG,
/// from orders through fills, exercise, expiry, settlement and withdrawal. Outcomes are checked
/// against balances, not against the contract's own formulas.
contract LifecycleCampaignForkTest is VayleMarketFork {
    uint256 internal constant MAX_ORDERS = 4;
    uint256 internal constant PERCENT = 100;

    struct OrderPlan {
        uint8 owner;
        bool put;
        uint16 lots;
        uint16 floorTicks;
        uint8 fillPercent;
        uint32 premiumTicks;
    }

    struct WeekPlan {
        OrderPlan[4] orders;
        uint8 count;
        uint16 feeBps;
        uint8 callExercisePercent;
        uint8 putExercisePercent;
    }

    struct Ledger {
        int256 nvda;
        int256 usdg;
    }

    address[5] internal parties;
    mapping(address party => Ledger) internal start;

    function _recordStart() internal {
        parties = [alice, bob, carol, quoter, treasury];
        for (uint256 i; i < parties.length; ++i) {
            address party = parties[i];
            start[party] = Ledger(_balance(nvda, party), _balance(usdg, party));
        }
    }

    function _balance(address token, address party) internal view returns (int256) {
        return int256(IERC20(token).balanceOf(party));
    }

    function _change(address party) internal view returns (Ledger memory) {
        return Ledger(
            _balance(nvda, party) - start[party].nvda, _balance(usdg, party) - start[party].usdg
        );
    }

    /// @return id The order.
    /// @return premiumValue The premium the maker paid for it.
    function _placeAndFill(OrderPlan memory o) internal returns (uint256 id, uint256 premiumValue) {
        address owner = [alice, bob, carol][o.owner % 3];
        uint256 lots = bound(o.lots, 1, 100);
        OptionType side = o.put ? OptionType.Put : OptionType.Call;
        CollateralVault.OrderParams memory p =
            _params(side, o.put ? putStrike : callStrike, lots * LOT);
        p.minPremium = bound(o.floorTicks, 0, 1000) * PRICE_TICK;
        vm.prank(owner);
        id = market.placeOrder(p);

        uint256 amount = ((lots * bound(o.fillPercent, 0, PERCENT)) / PERCENT) * LOT;
        if (amount == 0) return (id, 0);
        uint256 premium = p.minPremium + bound(o.premiumTicks, 0, 1_000_000) * PRICE_TICK;
        uint256 credited = market.claimable(owner, usdg);
        (QuoteSettlement.Quote memory q, bytes memory sig) =
            _signedQuoteAt(o.put ? putSeries : callSeries, amount, premium);
        market.fillQuote(q, sig, id, amount);
        premiumValue = (amount * premium) / RAW_UNIT;
        assertEq(market.claimable(owner, usdg) - credited, premiumValue, "premium credited");
    }

    function _cancelAll(uint256[] memory ids) internal {
        for (uint256 i; i < ids.length; ++i) {
            CollateralVault.Order memory o = market.orderOf(ids[i]);
            if (o.status != CollateralVault.OrderStatus.Active) continue;
            vm.prank(o.owner);
            market.cancelOrder(ids[i]);
        }
    }

    function _exerciseShare(uint256 series, uint256 percent) internal returns (uint256 amount) {
        uint256 lots = market.poolOf(series).written / LOT;
        amount = ((lots * bound(percent, 0, PERCENT)) / PERCENT) * LOT;
        if (amount == 0) return 0;
        vm.prank(quoter);
        market.exercise(series, amount);
    }

    /// @dev Settles every order written into `series` and checks each writer got at least the floor
    /// of its exact pro-rata share of collateral and proceeds, with exact totals.
    function _settleSeries(uint256[] memory ids, uint256 series) internal {
        CollateralVault.Pool memory pool = market.poolOf(series);
        bool isCall = market.seriesKey(series).optionType == OptionType.Call;
        (address backToken, address proceedsToken) = isCall ? (nvda, usdg) : (usdg, nvda);
        uint256 backPaid;
        uint256 proceedsPaid;
        for (uint256 i; i < ids.length; ++i) {
            CollateralVault.Order memory o = market.orderOf(ids[i]);
            if (o.series != series) continue;
            uint256 backBefore = market.claimable(o.owner, backToken);
            uint256 proceedsBefore = market.claimable(o.owner, proceedsToken);
            market.settleOrder(ids[i]);
            uint256 back = market.claimable(o.owner, backToken) - backBefore;
            uint256 proceeds = market.claimable(o.owner, proceedsToken) - proceedsBefore;
            assertGe(back, (pool.collateral * o.committed) / pool.written, "collateral share");
            assertGe(proceeds, (pool.proceeds * o.committed) / pool.written, "proceeds share");
            backPaid += back;
            proceedsPaid += proceeds;
        }
        assertEq(backPaid, pool.collateral, "all collateral returned");
        assertEq(proceedsPaid, pool.proceeds, "all proceeds paid");
    }

    function _withdrawAll() internal {
        for (uint256 i; i < parties.length; ++i) {
            for (uint256 t; t < 2; ++t) {
                address token = t == 0 ? nvda : usdg;
                uint256 amount = market.claimable(parties[i], token);
                if (amount == 0) continue;
                vm.prank(parties[i]);
                market.withdraw(token, amount);
            }
        }
    }

    /// forge-config: default.fuzz.runs = 512
    /// forge-config: ci.fuzz.runs = 4096
    function testFuzz_aFullWeekSettlesEveryoneExactly(WeekPlan memory plan) public {
        // #given: up to four orders, each partly filled at its own premium, then cancelled so
        // everything is released at settlement
        uint16 feeBps = uint16(bound(plan.feeBps, 0, 500));
        vm.prank(timelock);
        market.setFee(feeBps, treasury);
        _recordStart();
        uint256[] memory ids = new uint256[](bound(plan.count, 1, MAX_ORDERS));
        uint256 premiums;
        uint256 fees;
        for (uint256 i; i < ids.length; ++i) {
            uint256 premiumValue;
            (ids[i], premiumValue) = _placeAndFill(plan.orders[i]);
            premiums += premiumValue;
            fees += Units.fee(premiumValue, feeBps);
        }
        _cancelAll(ids);

        // #when: the maker exercises part of each side, the series settle, everyone withdraws
        _intoTheWindow();
        uint256 calls = _exerciseShare(callSeries, plan.callExercisePercent);
        uint256 puts = _exerciseShare(putSeries, plan.putExercisePercent);
        _pastTheWindow();
        market.finalize(callSeries);
        market.finalize(putSeries);
        _settleSeries(ids, callSeries);
        _settleSeries(ids, putSeries);
        _withdrawAll();

        // #then: nothing is left in the market, and the maker paid and received exactly its trades
        assertEq(IERC20(nvda).balanceOf(address(market)), 0, "no NVDA left");
        assertEq(IERC20(usdg).balanceOf(address(market)), 0, "no USDG left");
        Ledger memory maker = _change(quoter);
        int256 strikesPaid = int256(_value(calls, callStrike)) - int256(_value(puts, putStrike));
        assertEq(maker.usdg, -int256(premiums + fees) - strikesPaid, "maker USDG");
        assertEq(maker.nvda, int256(calls) - int256(puts), "maker NVDA");
        assertEq(_change(treasury).usdg, int256(fees), "fees");
    }
}
