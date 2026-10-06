// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";
import {ForkTest} from "./ForkTest.sol";

/// @notice Fork fixture that replays real history: it warps back before recent Friday closes so
/// the calendar can hold them, then uses the feed's real rounds at those closes.
abstract contract MarketFork is ForkTest {
    // Friday 16:00 ET closes in UTC, regular sessions on the exchange's published calendar.
    uint64 internal constant SEP_18 = 1_789_761_600;
    uint64 internal constant SEP_25 = 1_790_366_400;
    uint64 internal constant OCT_02 = 1_790_971_200;
    uint64 internal constant OCT_09 = 1_791_576_000;
    uint64 internal constant OCT_16 = 1_792_180_800;

    uint256 internal constant LOT = 1e16;
    uint256 internal constant PRICE_TICK = 100;
    uint256 internal constant STRIKE_TICK = 5e6;
    uint16 internal constant STRIKE_RANGE_BPS = 1000;

    address internal admin = makeAddr("admin");
    SessionCalendar internal calendar;
    StockTokenRegistry internal registry;
    PriceAdapter internal adapter;
    LivenessCheckpoint internal liveness;

    function setUp() public virtual override {
        super.setUp();
        vm.warp(SEP_18 - 2 days);
        calendar = new SessionCalendar(admin);
        uint64[] memory closes = new uint64[](5);
        (closes[0], closes[1], closes[2], closes[3], closes[4]) =
        (SEP_18, SEP_25, OCT_02, OCT_09, OCT_16);
        vm.prank(admin);
        calendar.append(closes);
        registry = new StockTokenRegistry(admin, IERC20Metadata(usdg));
        vm.prank(admin);
        registry.list(
            nvda, nvdaUid, IPriceFeed(nvdaFeed), LOT, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS
        );
        adapter = new PriceAdapter(registry);
        liveness = new LivenessCheckpoint();
    }

    /// @dev Walks back from the latest round to the last one at or before `cutoff`.
    function _lastRoundAtOrBefore(uint64 cutoff)
        internal
        view
        returns (uint80 id, int256 answer, uint256 updatedAt)
    {
        (id,,,,) = IPriceFeed(nvdaFeed).latestRoundData();
        while (true) {
            (, answer,, updatedAt,) = IPriceFeed(nvdaFeed).getRoundData(id);
            if (updatedAt <= cutoff) return (id, answer, updatedAt);
            id -= 1;
        }
    }

    function _referencePriceFrom(int256 answer) internal view returns (uint256) {
        return uint256(answer) / 10 ** (IPriceFeed(nvdaFeed).decimals() - usdgDecimals);
    }

    /// @dev A keeper pinging every minute from `from` to `to`.
    function _keepAlive(uint256 from, uint256 to) internal {
        for (uint256 t = from; t <= to; t += 1 minutes) {
            vm.warp(t);
            liveness.checkpoint();
        }
    }
}
