// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {SessionRules} from "../../src/libraries/SessionRules.sol";

contract SessionRulesTest is Test {
    // Closes from the exchange's published 2026 and 2027 calendar, in UTC.
    uint256 internal constant FRI_2026_10_09_1600_EDT = 1_791_576_000;
    uint256 internal constant FRI_2026_11_27_1300_EST = 1_795_802_400;
    uint256 internal constant THU_2026_12_24_1300_EST = 1_798_135_200;
    uint256 internal constant THU_2026_12_31_1600_EST = 1_798_750_800;
    uint256 internal constant FRI_2027_03_19_1600_EDT = 1_805_486_400;
    uint256 internal constant THU_2027_03_25_1300_EDT = 1_805_994_000;

    function test_weekdayOfAKnownFridayIsFive() public pure {
        // #when
        uint256 day = SessionRules.weekday(FRI_2026_10_09_1600_EDT);
        // #then
        assertEq(day, 5);
    }

    function test_acceptsRegularAndEarlyClosesInBothDstRegimes() public pure {
        // #then
        assertTrue(SessionRules.isSessionClose(FRI_2026_10_09_1600_EDT));
        assertTrue(SessionRules.isSessionClose(FRI_2026_11_27_1300_EST));
        assertTrue(SessionRules.isSessionClose(THU_2026_12_24_1300_EST));
        assertTrue(SessionRules.isSessionClose(THU_2026_12_31_1600_EST));
        assertTrue(SessionRules.isSessionClose(FRI_2027_03_19_1600_EDT));
        assertTrue(SessionRules.isSessionClose(THU_2027_03_25_1300_EDT));
    }

    function test_rejectsWeekends() public pure {
        // #given
        uint256 saturday = FRI_2026_10_09_1600_EDT + 1 days;
        uint256 sunday = FRI_2026_10_09_1600_EDT + 2 days;
        // #then
        assertFalse(SessionRules.isSessionClose(saturday));
        assertFalse(SessionRules.isSessionClose(sunday));
    }

    function test_rejectsOffHourAndOffMinuteTimes() public pure {
        // #then
        assertFalse(SessionRules.isSessionClose(FRI_2026_10_09_1600_EDT - 1 hours));
        assertFalse(SessionRules.isSessionClose(FRI_2026_10_09_1600_EDT + 30 minutes));
        assertFalse(SessionRules.isSessionClose(FRI_2026_10_09_1600_EDT + 1));
    }

    function testFuzz_everyAcceptedTimeIsAWeekdayOnTheHour(uint256 timestamp) public pure {
        // #given
        timestamp = bound(timestamp, 0, type(uint64).max);
        vm.assume(SessionRules.isSessionClose(timestamp));
        // #when
        uint256 day = SessionRules.weekday(timestamp);
        uint256 hour = (timestamp % 1 days) / 1 hours;
        // #then
        assertTrue(day >= 1 && day <= 5);
        assertEq(timestamp % 1 hours, 0);
        assertTrue(hour == 17 || hour == 18 || hour == 20 || hour == 21);
    }

    function testFuzz_weekdayAdvancesByOneEachDay(uint256 timestamp) public pure {
        // #given
        timestamp = bound(timestamp, 0, type(uint64).max - 1 days);
        // #when
        uint256 today = SessionRules.weekday(timestamp);
        uint256 tomorrow = SessionRules.weekday(timestamp + 1 days);
        // #then
        assertEq(tomorrow, (today + 1) % 7);
    }
}
