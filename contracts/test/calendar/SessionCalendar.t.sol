// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";

contract SessionCalendarTest is Test {
    // Friday 16:00 ET boundaries, 2026-10-09 through 2026-11-06 (DST ends 2026-11-01).
    uint64 internal constant OCT_09 = 1_791_576_000;
    uint64 internal constant OCT_16 = 1_792_180_800;
    uint64 internal constant OCT_23 = 1_792_785_600;
    uint64 internal constant OCT_30 = 1_793_390_400;
    uint64 internal constant NOV_06 = 1_793_998_800;
    // Two days before the first close.
    uint256 internal constant NOW = OCT_09 - 2 days;

    address internal timelock = makeAddr("timelock");
    SessionCalendar internal calendar;

    event ClosesAppended(uint256 indexed fromIndex, uint64[] closes);
    event ClosesTruncated(uint256 indexed keep, uint256 removed);

    function setUp() public {
        vm.warp(NOW);
        calendar = new SessionCalendar(timelock);
    }

    function _weeks() internal pure returns (uint64[] memory closes) {
        closes = new uint64[](5);
        closes[0] = OCT_09;
        closes[1] = OCT_16;
        closes[2] = OCT_23;
        closes[3] = OCT_30;
        closes[4] = NOV_06;
    }

    function _one(uint64 close) internal pure returns (uint64[] memory closes) {
        closes = new uint64[](1);
        closes[0] = close;
    }

    function test_appendStoresClosesInOrderAndEmits() public {
        // #given
        uint64[] memory closes = _weeks();
        // #then
        vm.expectEmit(address(calendar));
        emit ClosesAppended(0, closes);
        // #when
        vm.prank(timelock);
        calendar.append(closes);
        // #then
        assertEq(calendar.closeCount(), 5);
        assertEq(calendar.closeAt(0), OCT_09);
        assertEq(calendar.closeAt(4), NOV_06);
    }

    function test_appendRejectsANonCloseTimestamp() public {
        // #given
        uint64 saturday = OCT_09 + 1 days;
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NotASessionClose.selector, saturday));
        // #when
        vm.prank(timelock);
        calendar.append(_one(saturday));
    }

    function test_appendRejectsACloseNotAfterTheLastOne() public {
        // #given
        vm.prank(timelock);
        calendar.append(_one(OCT_16));
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.NotIncreasing.selector, OCT_16, OCT_09)
        );
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_09));
    }

    function test_appendRejectsACloseWithinTheMinimumLead() public {
        // #given
        vm.warp(OCT_09 - 12 hours);
        uint256 earliest = block.timestamp + calendar.MIN_LEAD();
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.TooSoon.selector, OCT_09, earliest));
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_09));
    }

    function test_appendIsOwnerOnly() public {
        // #given
        address stranger = makeAddr("stranger");
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        // #when
        vm.prank(stranger);
        calendar.append(_one(OCT_09));
    }

    function test_truncateRemovesFutureClosesFromAnIndex() public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        // #then
        vm.expectEmit(address(calendar));
        emit ClosesTruncated(2, 3);
        // #when
        vm.prank(timelock);
        calendar.truncate(2);
        // #then
        assertEq(calendar.closeCount(), 2);
        assertEq(calendar.closeAt(1), OCT_16);
    }

    function test_truncateRefusesToRemoveAnImminentClose() public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        vm.warp(OCT_16 - 12 hours);
        uint256 earliest = block.timestamp + calendar.MIN_LEAD();
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.TooSoon.selector, OCT_16, earliest));
        // #when
        vm.prank(timelock);
        calendar.truncate(1);
    }

    function test_truncateRefusesWhenNothingWouldBeRemoved() public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NothingToTruncate.selector, 5, 5));
        // #when
        vm.prank(timelock);
        calendar.truncate(5);
    }

    function test_truncateIsOwnerOnly() public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        address stranger = makeAddr("stranger");
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        // #when
        vm.prank(stranger);
        calendar.truncate(0);
    }

    function testFuzz_nextCloseAfterMatchesALinearScan(uint64 timestamp) public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        uint64[] memory closes = _weeks();
        timestamp = uint64(bound(timestamp, 0, NOV_06 - 1));
        uint64 expected;
        for (uint256 i; i < closes.length; ++i) {
            if (closes[i] > timestamp) {
                expected = closes[i];
                break;
            }
        }
        // #when
        uint64 found = calendar.nextCloseAfter(timestamp);
        // #then
        assertEq(found, expected);
    }

    function test_nextCloseAfterRevertsPastTheLastClose() public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NoCloseAfter.selector, NOV_06));
        // #when
        calendar.nextCloseAfter(NOV_06);
    }

    function test_nextCloseAfterRevertsOnAnEmptyCalendar() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NoCloseAfter.selector, uint64(0)));
        // #when
        calendar.nextCloseAfter(0);
    }

    function testFuzz_latestCloseAtOrBeforeMatchesALinearScan(uint64 timestamp) public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        uint64[] memory closes = _weeks();
        timestamp = uint64(bound(timestamp, OCT_09, type(uint64).max));
        uint64 expected;
        for (uint256 i; i < closes.length; ++i) {
            if (closes[i] <= timestamp) expected = closes[i];
        }
        // #when
        uint64 found = calendar.latestCloseAtOrBefore(timestamp);
        // #then
        assertEq(found, expected);
    }

    function test_latestCloseAtOrBeforeRevertsBeforeTheFirstClose() public {
        // #given
        vm.prank(timelock);
        calendar.append(_weeks());
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.NoCloseAtOrBefore.selector, OCT_09 - 1)
        );
        // #when
        calendar.latestCloseAtOrBefore(OCT_09 - 1);
    }
}
