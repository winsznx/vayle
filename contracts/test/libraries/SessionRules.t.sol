// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {SessionRules} from "../../src/libraries/SessionRules.sol";

contract SessionRulesTest is Test {
    // Closes from the exchange's published 2026 to 2028 calendar, in UTC.
    uint256 internal constant FRI_2026_10_09_1600_EDT = 1_791_576_000;
    uint256 internal constant FRI_2026_11_27_1300_EST = 1_795_802_400;
    uint256 internal constant THU_2026_12_24_1300_EST = 1_798_135_200;
    uint256 internal constant THU_2026_12_31_1600_EST = 1_798_750_800;
    uint256 internal constant FRI_2027_03_19_1600_EDT = 1_805_486_400;
    uint256 internal constant MON_2028_07_03_1300_EDT = 1_846_256_400;
    // Monday opens on both sides of the 2026-11-01 change to standard time.
    uint256 internal constant MON_2026_10_12_0930_EDT = 1_791_811_800;
    uint256 internal constant MON_2026_11_02_0930_EST = 1_793_629_800;

    // 1970-01-04 was a Sunday.
    uint256 internal constant FIRST_SUNDAY = 3 days;
    // Keeps every built timestamp inside uint64.
    uint256 internal constant MAX_WEEK = 1e12;

    function _weekday(uint256 week, uint256 day) internal pure returns (uint256) {
        return FIRST_SUNDAY + week * 7 days + day * 1 days;
    }

    function _closeHour(uint256 choice) internal pure returns (uint256) {
        uint256[4] memory hours_ = [uint256(17), 18, 20, 21];
        return hours_[choice % 4];
    }

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
        assertTrue(SessionRules.isSessionClose(MON_2028_07_03_1300_EDT));
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

    function testFuzz_acceptsEveryWeekdayAtACloseHour(uint256 week, uint256 day, uint256 hour)
        public
        pure
    {
        // #given
        week = bound(week, 0, MAX_WEEK);
        day = bound(day, 1, 5);
        uint256 timestamp = _weekday(week, day) + _closeHour(hour) * 1 hours;
        // #when
        bool accepted = SessionRules.isSessionClose(timestamp);
        // #then
        assertTrue(accepted);
    }

    function testFuzz_rejectsACloseHourMovedOffTheHour(
        uint256 week,
        uint256 day,
        uint256 hour,
        uint256 offset
    ) public pure {
        // #given
        week = bound(week, 0, MAX_WEEK);
        day = bound(day, 1, 5);
        offset = bound(offset, 1, 1 hours - 1);
        uint256 timestamp = _weekday(week, day) + _closeHour(hour) * 1 hours + offset;
        // #when
        bool accepted = SessionRules.isSessionClose(timestamp);
        // #then
        assertFalse(accepted);
    }

    function testFuzz_rejectsWeekendsAtEveryTime(uint256 week, bool sunday, uint256 secondOfDay)
        public
        pure
    {
        // #given
        week = bound(week, 0, MAX_WEEK);
        secondOfDay = bound(secondOfDay, 0, 1 days - 1);
        uint256 timestamp = _weekday(week, sunday ? 0 : 6) + secondOfDay;
        // #when
        bool accepted = SessionRules.isSessionClose(timestamp);
        // #then
        assertFalse(accepted);
    }

    function testFuzz_rejectsWeekdayHoursThatArentCloses(uint256 week, uint256 day, uint256 hour)
        public
        pure
    {
        // #given
        week = bound(week, 0, MAX_WEEK);
        day = bound(day, 1, 5);
        hour = bound(hour, 0, 23);
        vm.assume(hour != 17 && hour != 18 && hour != 20 && hour != 21);
        uint256 timestamp = _weekday(week, day) + hour * 1 hours;
        // #when
        bool accepted = SessionRules.isSessionClose(timestamp);
        // #then
        assertFalse(accepted);
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

    function test_acceptsMondayOpensInBothDstRegimes() public pure {
        // #then
        assertTrue(SessionRules.isMondayOpen(MON_2026_10_12_0930_EDT));
        assertTrue(SessionRules.isMondayOpen(MON_2026_11_02_0930_EST));
    }

    function testFuzz_acceptsEveryMondayAtAnOpen(uint256 week, bool standardTime) public pure {
        // #given
        week = bound(week, 0, MAX_WEEK);
        uint256 timestamp = _weekday(week, 1) + (standardTime ? 14 hours : 13 hours) + 30 minutes;
        // #when
        bool accepted = SessionRules.isMondayOpen(timestamp);
        // #then
        assertTrue(accepted);
    }

    function testFuzz_rejectsOpenTimesOnOtherDays(uint256 week, uint256 day, bool standardTime)
        public
        pure
    {
        // #given
        week = bound(week, 0, MAX_WEEK);
        day = bound(day, 0, 6);
        vm.assume(day != 1);
        uint256 timestamp = _weekday(week, day) + (standardTime ? 14 hours : 13 hours) + 30 minutes;
        // #when
        bool accepted = SessionRules.isMondayOpen(timestamp);
        // #then
        assertFalse(accepted);
    }

    function testFuzz_rejectsOtherTimesOnMondays(uint256 week, uint256 secondOfDay) public pure {
        // #given
        week = bound(week, 0, MAX_WEEK);
        secondOfDay = bound(secondOfDay, 0, 1 days - 1);
        vm.assume(secondOfDay != 13 hours + 30 minutes && secondOfDay != 14 hours + 30 minutes);
        uint256 timestamp = _weekday(week, 1) + secondOfDay;
        // #when
        bool accepted = SessionRules.isMondayOpen(timestamp);
        // #then
        assertFalse(accepted);
    }
}
