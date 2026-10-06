// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {
    CollateralMode,
    ExerciseStyle,
    OptionType,
    SeriesId,
    SeriesKey,
    SettlementType
} from "../../src/libraries/SeriesId.sol";

contract SeriesIdTest is Test {
    function _key() internal pure returns (SeriesKey memory) {
        return SeriesKey({
            chainId: 4663,
            asset: address(0xA11CE),
            optionType: OptionType.Call,
            strike: 250e6,
            expiry: 1_791_576_000,
            windowLength: 2 hours,
            unitBasis: SeriesId.RAW_UNITS,
            exerciseStyle: ExerciseStyle.European,
            settlementType: SettlementType.Physical,
            collateralToken: address(0xA11CE),
            collateralMode: CollateralMode.Idle
        });
    }

    function testFuzz_changingAnyTermChangesTheId(uint8 field, uint256 delta) public pure {
        // #given
        SeriesKey memory base = _key();
        SeriesKey memory changed = _key();
        delta = bound(delta, 1, type(uint32).max);
        field = uint8(bound(field, 0, 6));
        if (field == 0) {
            changed.chainId += delta;
        } else if (field == 1) {
            changed.asset = address(uint160(changed.asset) + uint160(delta));
        } else if (field == 2) {
            changed.optionType = OptionType.Put;
        } else if (field == 3) {
            changed.strike += delta;
        } else if (field == 4) {
            changed.expiry += uint64(delta);
        } else if (field == 5) {
            changed.windowLength = uint32(changed.windowLength + delta % 1 days + 1);
        } else {
            changed.collateralToken = address(uint160(changed.collateralToken) + uint160(delta));
        }
        // #when
        uint256 a = SeriesId.id(base);
        uint256 b = SeriesId.id(changed);
        // #then
        assertNotEq(a, b);
    }

    function test_theSameTermsGiveTheSameId() public pure {
        // #then
        assertEq(SeriesId.id(_key()), SeriesId.id(_key()));
    }
}
