// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";

contract SessionCalendarTest is Test {
    // Friday 16:00 ET boundaries, 2026-10-09 through 2026-11-06 (DST ends 2026-11-01), each with
    // the Monday 09:30 ET after it.
    uint64 internal constant OCT_09 = 1_791_576_000;
    uint64 internal constant OCT_12_OPEN = 1_791_811_800;
    uint64 internal constant OCT_16 = 1_792_180_800;
    uint64 internal constant OCT_19_OPEN = 1_792_416_600;
    uint64 internal constant OCT_23 = 1_792_785_600;
    uint64 internal constant OCT_26_OPEN = 1_793_021_400;
    uint64 internal constant OCT_30 = 1_793_390_400;
    uint64 internal constant NOV_02_OPEN = 1_793_629_800;
    uint64 internal constant NOV_06 = 1_793_998_800;
    uint64 internal constant NOV_09_OPEN = 1_794_234_600;
    // Two days before the first close.
    uint256 internal constant NOW = OCT_09 - 2 days;

    address internal timelock = makeAddr("timelock");
    SessionCalendar internal calendar;

    event BoundariesAppended(uint256 indexed fromIndex, SessionCalendar.Boundary[] boundaries);
    event BoundariesTruncated(uint256 indexed keep, uint256 removed);

    function setUp() public {
        vm.warp(NOW);
        calendar = new SessionCalendar(timelock, new SessionCalendar.Boundary[](0));
    }

    function _weeks() internal pure returns (SessionCalendar.Boundary[] memory boundaries) {
        boundaries = new SessionCalendar.Boundary[](5);
        boundaries[0] = SessionCalendar.Boundary(OCT_09, OCT_12_OPEN);
        boundaries[1] = SessionCalendar.Boundary(OCT_16, OCT_19_OPEN);
        boundaries[2] = SessionCalendar.Boundary(OCT_23, OCT_26_OPEN);
        boundaries[3] = SessionCalendar.Boundary(OCT_30, NOV_02_OPEN);
        boundaries[4] = SessionCalendar.Boundary(NOV_06, NOV_09_OPEN);
    }

    function _one(uint64 close, uint64 creationDeadline)
        internal
        pure
        returns (SessionCalendar.Boundary[] memory boundaries)
    {
        boundaries = new SessionCalendar.Boundary[](1);
        boundaries[0] = SessionCalendar.Boundary(close, creationDeadline);
    }

    function _appendWeeks() internal {
        vm.prank(timelock);
        calendar.append(_weeks());
    }

    function _closes() internal pure returns (uint64[5] memory) {
        return [OCT_09, OCT_16, OCT_23, OCT_30, NOV_06];
    }

    function test_constructorSchedulesACloseLessThanADayAway() public {
        // #given: a deploy on the morning of the first close
        vm.warp(OCT_09 - 9 hours);
        SessionCalendar.Boundary[] memory boundaries = _weeks();
        // #then
        vm.expectEmit();
        emit BoundariesAppended(0, boundaries);
        // #when
        SessionCalendar deployed = new SessionCalendar(timelock, boundaries);
        // #then
        assertEq(deployed.boundaryCount(), 5);
        assertEq(deployed.boundaryAt(0).close, OCT_09);
        assertEq(deployed.nextCloseAfter(uint64(vm.getBlockTimestamp())), OCT_09);
    }

    function test_constructorRejectsACloseThatIsntInTheFuture() public {
        // #given
        vm.warp(OCT_09);
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.TooSoon.selector, OCT_09, OCT_09));
        // #when
        new SessionCalendar(timelock, _one(OCT_09, OCT_12_OPEN));
    }

    function test_constructorAppliesEveryOtherCheck() public {
        // #given
        SessionCalendar.Boundary[] memory outOfOrder = new SessionCalendar.Boundary[](2);
        outOfOrder[0] = SessionCalendar.Boundary(OCT_16, OCT_19_OPEN);
        outOfOrder[1] = SessionCalendar.Boundary(OCT_09, OCT_12_OPEN);
        uint64 saturday = OCT_09 + 1 days;
        uint64 aWeekLate = OCT_12_OPEN + 7 days;
        // #when #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NotASessionClose.selector, saturday));
        new SessionCalendar(timelock, _one(saturday, OCT_12_OPEN));
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.NotIncreasing.selector, OCT_16, OCT_09)
        );
        new SessionCalendar(timelock, outOfOrder);
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.BadCreationDeadline.selector, OCT_09, aWeekLate)
        );
        new SessionCalendar(timelock, _one(OCT_09, aWeekLate));
    }

    function test_appendStoresBoundariesInOrderAndEmits() public {
        // #given
        SessionCalendar.Boundary[] memory boundaries = _weeks();
        // #then
        vm.expectEmit(address(calendar));
        emit BoundariesAppended(0, boundaries);
        // #when
        vm.prank(timelock);
        calendar.append(boundaries);
        // #then
        assertEq(calendar.boundaryCount(), 5);
        assertEq(calendar.boundaryAt(0).close, OCT_09);
        assertEq(calendar.boundaryAt(0).creationDeadline, OCT_12_OPEN);
        assertEq(calendar.boundaryAt(4).close, NOV_06);
        assertEq(calendar.boundaryAt(4).creationDeadline, NOV_09_OPEN);
    }

    function test_appendRejectsANonCloseTimestamp() public {
        // #given
        uint64 saturday = OCT_09 + 1 days;
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NotASessionClose.selector, saturday));
        // #when
        vm.prank(timelock);
        calendar.append(_one(saturday, OCT_12_OPEN));
    }

    function test_appendRejectsACloseNotAfterTheLastOne() public {
        // #given
        vm.prank(timelock);
        calendar.append(_one(OCT_16, OCT_19_OPEN));
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.NotIncreasing.selector, OCT_16, OCT_09)
        );
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_09, OCT_12_OPEN));
    }

    function test_appendRejectsACloseWithinTheMinimumLead() public {
        // #given
        vm.warp(OCT_09 - 12 hours);
        uint256 earliest = vm.getBlockTimestamp() + calendar.MIN_LEAD();
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.TooSoon.selector, OCT_09, earliest));
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_09, OCT_12_OPEN));
    }

    function test_appendRejectsADeadlineThatIsntAMondayOpen() public {
        // #given
        uint64 mondayAt0930Utc = OCT_12_OPEN - 4 hours;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionCalendar.BadCreationDeadline.selector, OCT_09, mondayAt0930Utc
            )
        );
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_09, mondayAt0930Utc));
    }

    function test_appendRejectsAMondayOpenThatIsntTheFirstAfterTheClose() public {
        // #given
        uint64 aWeekLate = OCT_12_OPEN + 7 days;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.BadCreationDeadline.selector, OCT_09, aWeekLate)
        );
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_09, aWeekLate));
    }

    function test_appendRejectsAMondayOpenBeforeTheClose() public {
        // #given
        uint64 theMondayBefore = OCT_12_OPEN - 7 days;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionCalendar.BadCreationDeadline.selector, OCT_09, theMondayBefore
            )
        );
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_09, theMondayBefore));
    }

    function test_appendRejectsAGapLongerThanTheCapWhileThePreviousCanStillOpen() public {
        // #given
        vm.prank(timelock);
        calendar.append(_one(OCT_09, OCT_12_OPEN));
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.TooFarApart.selector, OCT_09, OCT_30)
        );
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_30, NOV_02_OPEN));
    }

    function test_appendAcceptsAnyGapOnceThePreviousCanNoLongerOpen() public {
        // #given: the schedule ran out after Oct 9 and its creation deadline has passed
        vm.prank(timelock);
        calendar.append(_one(OCT_09, OCT_12_OPEN));
        vm.warp(OCT_12_OPEN);
        // #when
        vm.prank(timelock);
        calendar.append(_one(OCT_30, NOV_02_OPEN));
        // #then
        assertEq(calendar.nextCloseAfter(OCT_09), OCT_30);
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
        calendar.append(_one(OCT_09, OCT_12_OPEN));
    }

    function test_truncateRemovesFutureBoundariesFromAnIndex() public {
        // #given
        _appendWeeks();
        // #then
        vm.expectEmit(address(calendar));
        emit BoundariesTruncated(2, 3);
        // #when
        vm.prank(timelock);
        calendar.truncate(2);
        // #then
        assertEq(calendar.boundaryCount(), 2);
        assertEq(calendar.boundaryAt(1).close, OCT_16);
    }

    function test_truncateRefusesToRemoveTheNextClose() public {
        // #given: the epoch opened at Oct 9 expires at Oct 16
        _appendWeeks();
        vm.warp(OCT_09 + 1 hours);
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.ProtectedClose.selector, OCT_16));
        // #when
        vm.prank(timelock);
        calendar.truncate(1);
    }

    function test_truncateRefusesToRemoveAPastClose() public {
        // #given
        _appendWeeks();
        vm.warp(OCT_16 + 1 hours);
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.ProtectedClose.selector, OCT_09));
        // #when
        vm.prank(timelock);
        calendar.truncate(0);
    }

    function test_truncateRefusesToRemoveAnImminentClose() public {
        // #given: two plausible closes 20 hours apart, Thursday 21:00 and Friday 17:00 UTC
        uint64 thursday = OCT_09 - 23 hours;
        uint64 friday = OCT_09 - 3 hours;
        SessionCalendar.Boundary[] memory boundaries = new SessionCalendar.Boundary[](2);
        boundaries[0] = SessionCalendar.Boundary(thursday, OCT_12_OPEN);
        boundaries[1] = SessionCalendar.Boundary(friday, OCT_12_OPEN);
        vm.prank(timelock);
        calendar.append(boundaries);
        vm.warp(thursday - 1 hours);
        uint256 earliest = vm.getBlockTimestamp() + calendar.MIN_LEAD();
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.TooSoon.selector, friday, earliest));
        // #when
        vm.prank(timelock);
        calendar.truncate(1);
    }

    function test_truncateRefusesWhenNothingWouldBeRemoved() public {
        // #given
        _appendWeeks();
        // #then
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.NothingToTruncate.selector, 5, 5));
        // #when
        vm.prank(timelock);
        calendar.truncate(5);
    }

    function test_truncateIsOwnerOnly() public {
        // #given
        _appendWeeks();
        address stranger = makeAddr("stranger");
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        // #when
        vm.prank(stranger);
        calendar.truncate(1);
    }

    function testFuzz_nextCloseAfterMatchesALinearScan(uint64 timestamp) public {
        // #given
        _appendWeeks();
        uint64[5] memory closes = _closes();
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
        _appendWeeks();
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

    function testFuzz_latestBoundaryAtOrBeforeMatchesALinearScan(uint64 timestamp) public {
        // #given
        _appendWeeks();
        SessionCalendar.Boundary[] memory boundaries = _weeks();
        timestamp = uint64(bound(timestamp, OCT_09, type(uint64).max));
        SessionCalendar.Boundary memory expected;
        for (uint256 i; i < boundaries.length; ++i) {
            if (boundaries[i].close <= timestamp) expected = boundaries[i];
        }
        // #when
        SessionCalendar.Boundary memory found = calendar.latestBoundaryAtOrBefore(timestamp);
        // #then
        assertEq(abi.encode(found), abi.encode(expected));
    }

    function test_latestBoundaryAtOrBeforeRevertsBeforeTheFirstClose() public {
        // #given
        _appendWeeks();
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SessionCalendar.NoCloseAtOrBefore.selector, OCT_09 - 1)
        );
        // #when
        calendar.latestBoundaryAtOrBefore(OCT_09 - 1);
    }
}
