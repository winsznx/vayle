// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";
import {ChainActors, IOracleAdmin} from "../utils/ChainActors.sol";
import {MarketFork} from "../utils/MarketFork.sol";

interface IFeedProxyAdmin {
    function aggregator() external view returns (address);
    function proposeAggregator(address aggregator) external;
    function confirmAggregator(address aggregator) external;
}

/// @notice Prices the real Oct 2 close from the real NVDA feed's history.
contract PriceAdapterForkTest is MarketFork {
    error NoRoundAfter(uint64 close);

    uint256 internal constant PHASE_SHIFT = 64;
    uint256 internal constant ASSETS_SLOT = 2;

    uint80 internal lastRound;
    int256 internal lastAnswer;
    uint256 internal lastUpdatedAt;
    uint256 internal scale;

    function setUp() public override {
        super.setUp();
        vm.warp(OCT_02 + 10 minutes);
        (lastRound, lastAnswer, lastUpdatedAt) = _lastRoundAtOrBefore(OCT_02);
        scale = 10 ** (IPriceFeed(nvdaFeed).decimals() - usdgDecimals);
    }

    /// @dev Walks forward from the last round at or before `close` to the first one after it.
    function _firstRoundAfter(uint64 close) internal view returns (uint80 id, uint256 updatedAt) {
        (uint80 latest,,,,) = IPriceFeed(nvdaFeed).latestRoundData();
        for (id = lastRound + 1; id <= latest; ++id) {
            (,,, updatedAt,) = IPriceFeed(nvdaFeed).getRoundData(id);
            if (updatedAt > close) return (id, updatedAt);
        }
        revert NoRoundAfter(close);
    }

    /// @dev The real proxy owner confirms the current aggregator again as a new phase. The new
    /// phase's first round is then the aggregator's first round, long before the close.
    function _confirmTheSameAggregatorAsANewPhase() internal {
        IFeedProxyAdmin proxy = IFeedProxyAdmin(nvdaFeed);
        address current = proxy.aggregator();
        vm.startPrank(ChainActors.FEED_PROXY_OWNER);
        proxy.proposeAggregator(current);
        proxy.confirmAggregator(current);
        vm.stopPrank();
    }

    function _inPhase(uint256 phase, uint80 roundId) internal pure returns (uint80) {
        return uint80((phase << PHASE_SHIFT) | (roundId & type(uint64).max));
    }

    function test_acceptsTheLastRoundBeforeTheClose() public view {
        // #when
        (uint256 price, uint80 roundId, uint64 updatedAt) =
            adapter.referencePrice(nvda, OCT_02, lastRound, 0);
        // #then
        assertEq(roundId, lastRound);
        assertEq(updatedAt, lastUpdatedAt);
        assertEq(price, uint256(lastAnswer) / scale);
        assertGt(price, 0);
    }

    function test_refusesACloseThatHasntPassed() public {
        // #given
        vm.warp(OCT_02);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(PriceAdapter.CloseNotPassed.selector, OCT_02, uint256(OCT_02))
        );
        // #when
        adapter.referencePrice(nvda, OCT_02, lastRound, 0);
    }

    function test_refusesACloseInTheFuture() public {
        // #given
        vm.warp(OCT_02 - 1);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceAdapter.CloseNotPassed.selector, OCT_02, uint256(OCT_02 - 1)
            )
        );
        // #when
        adapter.referencePrice(nvda, OCT_02, lastRound, 0);
    }

    function test_refusesAnEarlierRound() public {
        // #given
        uint80 earlier = lastRound - 1;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(PriceAdapter.NotLastRoundBeforeClose.selector, earlier, OCT_02)
        );
        // #when
        adapter.referencePrice(nvda, OCT_02, earlier, 0);
    }

    function test_refusesARoundAfterTheClose() public {
        // #given
        (uint80 later, uint256 laterUpdatedAt) = _firstRoundAfter(OCT_02);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceAdapter.RoundAfterClose.selector, later, laterUpdatedAt, OCT_02
            )
        );
        // #when
        adapter.referencePrice(nvda, OCT_02, later, 0);
    }

    function test_refusesARoundOlderThanADayAtTheClose() public {
        // #given: a close 25 hours after the round, before the next round landed
        uint64 lateClose = uint64(lastUpdatedAt + 25 hours);
        vm.warp(lateClose + 1);
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
        adapter.referencePrice(nvda, OCT_02, future, 0);
    }

    function test_refusesARoundInAPhaseTheProxyDoesntHave() public {
        // #given
        uint80 unknownPhase = _inPhase(5, lastRound);
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.UnknownRound.selector, unknownPhase));
        // #when
        adapter.referencePrice(nvda, OCT_02, unknownPhase, 0);
    }

    function test_afterAPhaseChangeAnOldPhaseRoundIsRefused() public {
        // #given
        _confirmTheSameAggregatorAsANewPhase();
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(PriceAdapter.NotLastRoundBeforeClose.selector, lastRound, OCT_02)
        );
        // #when
        adapter.referencePrice(nvda, OCT_02, lastRound, 0);
    }

    function test_afterAPhaseChangeTheNewPhasesRoundIsAccepted() public {
        // #given
        _confirmTheSameAggregatorAsANewPhase();
        uint80 hint = _inPhase((uint256(lastRound) >> PHASE_SHIFT) + 1, lastRound);
        // #when
        (uint256 price, uint80 roundId,) = adapter.referencePrice(nvda, OCT_02, hint, 0);
        // #then
        assertEq(roundId, hint);
        assertEq(price, uint256(lastAnswer) / scale);
    }

    function test_acceptsAFallRightAtTheHalfBound() public view {
        // #given: the largest previous reference that the price is still at least half of
        uint256 previous = (uint256(lastAnswer) * 2) / scale;
        // #when
        (uint256 price,,) = adapter.referencePrice(nvda, OCT_02, lastRound, previous);
        // #then
        assertEq(price, uint256(lastAnswer) / scale);
    }

    function test_refusesAFallOneUnitPastTheHalfBound() public {
        // #given
        uint256 previous = (uint256(lastAnswer) * 2) / scale + 1;
        uint256 price = uint256(lastAnswer) / scale;
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.PriceJump.selector, price, previous));
        // #when
        adapter.referencePrice(nvda, OCT_02, lastRound, previous);
    }

    function test_acceptsARiseRightAtTheOneAndAHalfBound() public view {
        // #given: the smallest previous reference that the price is still within 1.5x of
        uint256 previous = (uint256(lastAnswer) * 2 + 3 * scale - 1) / (3 * scale);
        // #when
        (uint256 price,,) = adapter.referencePrice(nvda, OCT_02, lastRound, previous);
        // #then
        assertEq(price, uint256(lastAnswer) / scale);
    }

    function test_refusesARiseOneUnitPastTheOneAndAHalfBound() public {
        // #given
        uint256 previous = (uint256(lastAnswer) * 2 + 3 * scale - 1) / (3 * scale) - 1;
        uint256 price = uint256(lastAnswer) / scale;
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.PriceJump.selector, price, previous));
        // #when
        adapter.referencePrice(nvda, OCT_02, lastRound, previous);
    }

    function test_refusesWhileTheTokensOracleIsPaused() public {
        // #given: the real oracle pauser pauses NVDA's oracle
        vm.prank(ChainActors.ORACLE_PAUSER);
        IOracleAdmin(nvda).pauseOracle();
        // #then
        vm.expectRevert(abi.encodeWithSelector(PriceAdapter.OraclePaused.selector, nvda));
        // #when
        adapter.referencePrice(nvda, OCT_02, lastRound, 0);
    }

    function test_refusesWhenTheFeedsDecimalsNoLongerMatchTheListing() public {
        // #given: the listing's stored feed decimals no longer match the feed. The real feed
        // can't change its decimals on a fork without a fake aggregator, so the registry's stored
        // value is written instead.
        bytes32 assetSlot = keccak256(abi.encode(nvda, ASSETS_SLOT));
        bytes32 packed = bytes32(uint256(assetSlot) + 1);
        uint256 word = uint256(vm.load(address(registry), packed));
        uint256 feedDecimalsShift = 21 * 8;
        word = (word & ~(uint256(0xff) << feedDecimalsShift)) | (uint256(18) << feedDecimalsShift);
        vm.store(address(registry), packed, bytes32(word));
        uint8 current = IPriceFeed(nvdaFeed).decimals();
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceAdapter.FeedDecimalsChanged.selector, nvdaFeed, uint8(18), current
            )
        );
        // #when
        adapter.referencePrice(nvda, OCT_02, lastRound, 0);
    }

    function test_refusesAnUnlistedToken() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, usdg));
        // #when
        adapter.referencePrice(usdg, OCT_02, lastRound, 0);
    }
}
