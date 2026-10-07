// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {VayleMarket} from "../../src/VayleMarket.sol";
import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";
import {ForkTest} from "./ForkTest.sol";

/// @notice Fork fixture that replays real history: it warps back before recent Friday closes so
/// the calendar can hold them, then uses the feed's real rounds at those closes.
abstract contract MarketFork is ForkTest {
    // Friday 16:00 ET closes in UTC, regular sessions on the exchange's published calendar, each
    // with the Monday 09:30 ET after it. All fall in daylight time.
    uint64 internal constant SEP_18 = 1_789_761_600;
    uint64 internal constant SEP_21_OPEN = 1_789_997_400;
    uint64 internal constant SEP_25 = 1_790_366_400;
    uint64 internal constant SEP_28_OPEN = 1_790_602_200;
    uint64 internal constant OCT_02 = 1_790_971_200;
    uint64 internal constant OCT_05_OPEN = 1_791_207_000;
    uint64 internal constant OCT_09 = 1_791_576_000;
    uint64 internal constant OCT_12_OPEN = 1_791_811_800;
    uint64 internal constant OCT_16 = 1_792_180_800;
    uint64 internal constant OCT_19_OPEN = 1_792_416_600;

    // The keeper starts pinging this long before each close.
    uint64 internal constant KEEPER_LEAD = 45 minutes;

    // The market's order and strike grid, from its entry in deployments/markets.json.
    uint256 internal lot;
    uint256 internal priceTick;
    uint256 internal strikeTick;
    uint16 internal strikeRangeBps;

    address internal admin = makeAddr("admin");
    SessionCalendar internal calendar;
    StockTokenRegistry internal registry;
    PriceAdapter internal adapter;
    LivenessCheckpoint internal liveness;

    function setUp() public virtual override {
        super.setUp();
        lot = vm.parseJsonUint(marketsJson, string.concat(stockEntry, ".lot"));
        priceTick = vm.parseJsonUint(marketsJson, string.concat(stockEntry, ".priceTick"));
        strikeTick = vm.parseJsonUint(marketsJson, string.concat(stockEntry, ".strikeTick"));
        strikeRangeBps =
            uint16(vm.parseJsonUint(marketsJson, string.concat(stockEntry, ".strikeRangeBps")));
        vm.warp(SEP_18 - 2 days);
        SessionCalendar.Boundary[] memory boundaries = new SessionCalendar.Boundary[](5);
        boundaries[0] = SessionCalendar.Boundary(SEP_18, SEP_21_OPEN);
        boundaries[1] = SessionCalendar.Boundary(SEP_25, SEP_28_OPEN);
        boundaries[2] = SessionCalendar.Boundary(OCT_02, OCT_05_OPEN);
        boundaries[3] = SessionCalendar.Boundary(OCT_09, OCT_12_OPEN);
        boundaries[4] = SessionCalendar.Boundary(OCT_16, OCT_19_OPEN);
        calendar = new SessionCalendar(admin, boundaries);
        registry = new StockTokenRegistry(admin, IERC20Metadata(usdg));
        vm.prank(admin);
        registry.list(
            stock, stockUid, IPriceFeed(stockFeed), lot, priceTick, strikeTick, strikeRangeBps
        );
        adapter = new PriceAdapter(registry);
        liveness = new LivenessCheckpoint();
    }

    /// @dev Deploys the market from its build artifact. A suite that used `new` would carry the
    /// market's init code in its own bytecode and could outgrow the chain's code size limit.
    function _deployMarket(
        SessionCalendar calendar_,
        address owner,
        address guardian,
        address feeRecipient
    ) internal returns (VayleMarket) {
        bytes memory args = abi.encode(
            calendar_, registry, adapter, liveness, owner, guardian, feeRecipient
        );
        return VayleMarket(deployCode("VayleMarket.sol:VayleMarket", args));
    }

    /// @dev Walks back from the latest round to the last one at or before `cutoff`.
    function _lastRoundAtOrBefore(uint64 cutoff)
        internal
        view
        returns (uint80 id, int256 answer, uint256 updatedAt)
    {
        (id,,,,) = IPriceFeed(stockFeed).latestRoundData();
        while (true) {
            (, answer,, updatedAt,) = IPriceFeed(stockFeed).getRoundData(id);
            if (updatedAt <= cutoff) return (id, answer, updatedAt);
            id -= 1;
        }
    }

    function _referencePriceFrom(int256 answer) internal view returns (uint256) {
        return uint256(answer) / 10 ** (IPriceFeed(stockFeed).decimals() - usdgDecimals);
    }

    /// @dev A keeper pinging every minute from `from` to `to`.
    function _keepAlive(uint256 from, uint256 to) internal {
        for (uint256 t = from; t <= to; t += 1 minutes) {
            vm.warp(t);
            liveness.checkpoint();
        }
    }

    /// @dev The keeper's schedule around a close, starting at `from` (KEEPER_LEAD before it when
    /// on time): liveness pings every minute, NVDA oracle observations instead of pings in the
    /// lookback through the close, and pings after it until `until`.
    function _runKeeper(EpochBook book, uint64 close, uint256 from, uint256 until) internal {
        EpochBook[] memory books = new EpochBook[](1);
        books[0] = book;
        _runKeeper(books, close, from, until);
    }

    function _runKeeper(EpochBook[] memory books, uint64 close, uint256 from, uint256 until)
        internal
    {
        uint64 lookback = books[0].LIVENESS_LOOKBACK();
        for (uint256 t = from; t <= until; t += 1 minutes) {
            vm.warp(t);
            if (t + lookback >= close && t <= close) {
                for (uint256 i; i < books.length; ++i) {
                    books[i].observeClose(stock);
                }
            } else {
                liveness.checkpoint();
            }
        }
    }
}
