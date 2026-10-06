// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Units} from "../../src/libraries/Units.sol";

contract UnitsHarness {
    function value(uint256 amount, uint256 price, uint256 rawUnit, Math.Rounding rounding)
        external
        pure
        returns (uint256)
    {
        return Units.value(amount, price, rawUnit, rounding);
    }

    function valueExact(uint256 amount, uint256 price, uint256 rawUnit)
        external
        pure
        returns (uint256)
    {
        return Units.valueExact(amount, price, rawUnit);
    }

    function fee(uint256 premium, uint256 feeBps) external pure returns (uint256) {
        return Units.fee(premium, feeBps);
    }

    function requireLots(uint256 amount, uint256 lot) external pure {
        Units.requireLots(amount, lot);
    }

    function requireOnTick(uint256 price, uint256 tick) external pure {
        Units.requireOnTick(price, tick);
    }

    function gridIsExact(uint256 lot, uint256 priceTick, uint256 rawUnit)
        external
        pure
        returns (bool)
    {
        return Units.gridIsExact(lot, priceTick, rawUnit);
    }
}

contract UnitsTest is Test {
    uint256 internal constant RAW_UNIT = 1e18;
    uint256 internal constant LOT = RAW_UNIT / 100;
    uint256 internal constant PRICE_TICK = 100;

    UnitsHarness internal units;

    function setUp() public {
        units = new UnitsHarness();
    }

    function testFuzz_valueIsExactOnTheGrid(uint256 lots, uint256 ticks) public view {
        // #given
        lots = bound(lots, 1, 1e12);
        ticks = bound(ticks, 0, 1e12);
        uint256 amount = lots * LOT;
        uint256 price = ticks * PRICE_TICK;
        // #when
        uint256 result = units.valueExact(amount, price, RAW_UNIT);
        // #then
        assertEq(result * RAW_UNIT, amount * price);
    }

    function testFuzz_roundedValuesBracketTheExactProduct(uint256 amount, uint256 price)
        public
        view
    {
        // #given
        amount = bound(amount, 0, 1e30);
        price = bound(price, 0, 1e18);
        // #when
        uint256 down = units.value(amount, price, RAW_UNIT, Math.Rounding.Floor);
        uint256 up = units.value(amount, price, RAW_UNIT, Math.Rounding.Ceil);
        // #then
        assertLe(down * RAW_UNIT, amount * price);
        assertGe(up * RAW_UNIT, amount * price);
        assertLe(up - down, 1);
    }

    function test_valueExactRevertsOffTheGrid() public {
        // #given
        uint256 amount = 1;
        uint256 price = 1;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Units.InexactValue.selector, amount, price, RAW_UNIT)
        );
        // #when
        units.valueExact(amount, price, RAW_UNIT);
    }

    function testFuzz_feeRoundsUpToTheNextBaseUnit(uint256 premium, uint256 feeBps) public view {
        // #given
        premium = bound(premium, 0, 1e30);
        feeBps = bound(feeBps, 0, Units.BPS);
        // #when
        uint256 charged = units.fee(premium, feeBps);
        // #then
        assertGe(charged * Units.BPS, premium * feeBps);
        if (charged > 0) assertLt((charged - 1) * Units.BPS, premium * feeBps);
    }

    function test_requireLotsRejectsZero() public {
        // #then
        vm.expectRevert(Units.ZeroAmount.selector);
        // #when
        units.requireLots(0, LOT);
    }

    function testFuzz_requireLotsRejectsPartialLots(uint256 amount) public {
        // #given
        amount = bound(amount, 1, 1e30);
        vm.assume(amount % LOT != 0);
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotALot.selector, amount, LOT));
        // #when
        units.requireLots(amount, LOT);
    }

    function testFuzz_requireLotsAcceptsWholeLots(uint256 lots) public view {
        // #given
        lots = bound(lots, 1, 1e12);
        // #when
        units.requireLots(lots * LOT, LOT);
        // #then: no revert
    }

    function testFuzz_requireOnTickRejectsOffTickPrices(uint256 price) public {
        // #given
        price = bound(price, 0, 1e30);
        vm.assume(price % PRICE_TICK != 0);
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotOnTick.selector, price, PRICE_TICK));
        // #when
        units.requireOnTick(price, PRICE_TICK);
    }

    function test_gridIsExactForTheConfiguredLotAndTick() public view {
        // #when
        bool configured = units.gridIsExact(LOT, PRICE_TICK, RAW_UNIT);
        bool tooFine = units.gridIsExact(LOT, 1, RAW_UNIT);
        bool zeroLot = units.gridIsExact(0, PRICE_TICK, RAW_UNIT);
        // #then
        assertTrue(configured);
        assertFalse(tooFine);
        assertFalse(zeroLot);
    }
}
