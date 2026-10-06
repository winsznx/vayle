// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {ForkTest} from "../utils/ForkTest.sol";

interface IOraclePausable {
    function pauseOracle() external;
}

contract PriceAdapterForkTest is ForkTest {
    address internal admin = makeAddr("admin");
    StockTokenRegistry internal registry;
    PriceAdapter internal adapter;

    uint64 internal close;
    uint80 internal lastRound;
    int256 internal lastAnswer;
    uint256 internal lastUpdatedAt;

    function setUp() public override {
        super.setUp();
        registry = new StockTokenRegistry(admin, IERC20Metadata(usdg));
        vm.prank(admin);
        registry.list(nvda, nvdaUid, IPriceFeed(nvdaFeed), 1e16, 100, 5e6, 1000);
        adapter = new PriceAdapter(registry);
        close = _recentFridayClose();
        (lastRound, lastAnswer, lastUpdatedAt) = _lastRoundAtOrBefore(close);
    }

    /// @dev Friday 20:00 UTC (16:00 ET in daylight time), at least an hour before the fork block.
    function _recentFridayClose() internal view returns (uint64) {
        uint256 today = block.timestamp / 1 days;
        uint256 daysSinceFriday = (today + 4 + 7 - 5) % 7;
        uint256 candidate = (today - daysSinceFriday) * 1 days + 20 hours;
        if (candidate + 1 hours > block.timestamp) candidate -= 7 days;
        return uint64(candidate);
    }

    /// @dev Reference scan: walk back from the latest round to the last one at or before `cutoff`.
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

    function test_acceptsTheLastRoundBeforeTheClose() public view {
        // #when
        (uint256 price, uint80 roundId, uint64 updatedAt) =
            adapter.referencePrice(nvda, close, lastRound, 0);
        // #then
        assertEq(roundId, lastRound);
        assertEq(updatedAt, lastUpdatedAt);
        uint256 scale = 10 ** (IPriceFeed(nvdaFeed).decimals() - usdgDecimals);
        assertEq(price, uint256(lastAnswer) / scale);
        assertGt(price, 0);
    }

    function test_refusesAnEarlierRound() public {
        // #given
        uint80 earlier = lastRound - 1;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(PriceAdapter.NotLastRoundBeforeClose.selector, earlier, close)
        );
        // #when
        adapter.referencePrice(nvda, close, earlier, 0);
    }

    function test_refusesARoundAfterTheClose() public {
        // #given
        uint80 later = lastRound + 1;
        (,,, uint256 laterUpdatedAt,) = IPriceFeed(nvdaFeed).getRoundData(later);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceAdapter.RoundAfterClose.selector, later, laterUpdatedAt, close
            )
        );
        // #when
        adapter.referencePrice(nvda, close, later, 0);
    }

    function test_refusesARoundOlderThanADayAtTheClose() public {
        // #given
        uint64 lateClose = uint64(lastUpdatedAt + 25 hours);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceAdapter.StaleAtClose.selector, lastRound, lastUpdatedAt, lateClose
            )
        );
        // #when
        adapter.referencePrice(nvda, lateClose, lastRound, 0);
    }

    function test_refusesARoundTheFeedDoesntHave() public {
        // #given
        (uint80 latest,,,,) = IPriceFeed(nvdaFeed).latestRoundData();
        uint80 future = latest + 1000;
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.UnknownRound.selector, future));
        // #when
        adapter.referencePrice(nvda, close, future, 0);
    }

    function test_refusesAJumpOfMoreThanHalfFromThePreviousReference() public {
        // #given
        (uint256 price,,) = adapter.referencePrice(nvda, close, lastRound, 0);
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.PriceJump.selector, price, price * 3));
        // #when
        adapter.referencePrice(nvda, close, lastRound, price * 3);
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.PriceJump.selector, price, price / 3));
        // #when
        adapter.referencePrice(nvda, close, lastRound, price / 3);
    }

    function test_acceptsAPriceWithinHalfOfThePreviousReference() public view {
        // #given
        (uint256 price,,) = adapter.referencePrice(nvda, close, lastRound, 0);
        // #when
        (uint256 again,,) = adapter.referencePrice(nvda, close, lastRound, (price * 5) / 4);
        // #then
        assertEq(again, price);
    }

    function test_refusesWhileTheTokensOracleIsPaused() public {
        // #given: the real oracle pauser pauses NVDA's oracle
        vm.prank(ChainActors.ORACLE_PAUSER);
        IOraclePausable(nvda).pauseOracle();
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.OraclePaused.selector, nvda));
        // #when
        adapter.referencePrice(nvda, close, lastRound, 0);
    }

    function test_refusesAnUnlistedToken() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, usdg));
        // #when
        adapter.referencePrice(usdg, close, lastRound, 0);
    }
}
