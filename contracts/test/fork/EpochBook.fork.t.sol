// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {OptionSeries} from "../../src/core/OptionSeries.sol";
import {
    CollateralMode,
    ExerciseStyle,
    OptionType,
    SeriesId,
    SeriesKey,
    SettlementType
} from "../../src/libraries/SeriesId.sol";
import {EpochBookHarness} from "../core/EpochBookHarness.sol";
import {MarketFork} from "../utils/MarketFork.sol";

contract EpochBookForkTest is MarketFork {
    EpochBookHarness internal book;
    uint80 internal oct02Round;
    uint256 internal oct02Reference;

    event EpochCreated(
        address indexed asset,
        uint64 indexed expiry,
        uint64 opening,
        uint256 referencePrice,
        uint80 referenceRound,
        uint64 referenceUpdatedAt,
        uint32 windowLength
    );
    event SeriesRegistered(uint256 indexed id, SeriesKey key);

    function setUp() public override {
        super.setUp();
        book = new EpochBookHarness(calendar, registry, adapter, liveness);
        int256 answer;
        (oct02Round, answer,) = _lastRoundAtOrBefore(OCT_02);
        oct02Reference = _referencePriceFrom(answer);
    }

    function _createOct02() internal returns (uint64) {
        _keepAlive(OCT_02 - 40 minutes, OCT_02 + 10 minutes);
        return book.createEpoch(nvda, oct02Round);
    }

    function test_createsTheEpochFromTheLatestCloseToTheNext() public {
        // #given
        _keepAlive(OCT_02 - 40 minutes, OCT_02 + 10 minutes);
        (,, uint256 updatedAt) = _lastRoundAtOrBefore(OCT_02);
        // #then
        vm.expectEmit(address(book));
        emit EpochCreated(
            nvda, OCT_09, OCT_02, oct02Reference, oct02Round, uint64(updatedAt), 2 hours
        );
        // #when
        uint64 expiry = book.createEpoch(nvda, oct02Round);
        // #then
        EpochBook.Epoch memory e = book.epoch(nvda, expiry);
        assertEq(expiry, OCT_09);
        assertEq(e.opening, OCT_02);
        assertEq(e.referencePrice, oct02Reference);
        assertEq(e.windowLength, 2 hours);
        assertEq(e.lot, LOT);
        assertEq(e.strikeTick, STRIKE_TICK);
        assertEq(book.latestExpiry(nvda), OCT_09);
    }

    function test_refusesOnceTheCreationWindowHasClosed() public {
        // #given
        uint256 deadline = OCT_02 + book.CREATION_WINDOW();
        vm.warp(deadline);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(EpochBook.CreationWindowClosed.selector, OCT_02, deadline)
        );
        // #when
        book.createEpoch(nvda, oct02Round);
    }

    function test_refusesASecondEpochForTheSameExpiry() public {
        // #given
        _createOct02();
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.EpochExists.selector, nvda, OCT_09));
        // #when
        book.createEpoch(nvda, oct02Round);
    }

    function test_refusesWhenTheChainWentQuietBeforeTheClose() public {
        // #given: the last checkpoint was two hours before the close
        vm.warp(OCT_02 - 2 hours);
        liveness.checkpoint();
        vm.warp(OCT_02 + 10 minutes);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochBook.LivenessGapAtClose.selector, OCT_02, uint64(30 minutes)
            )
        );
        // #when
        book.createEpoch(nvda, oct02Round);
    }

    function test_checksTheJumpAgainstARecentPreviousEpoch() public {
        // #given: an epoch created at the Sep 25 close
        (uint80 sep25Round,,) = _lastRoundAtOrBefore(SEP_25);
        _keepAlive(SEP_25 - 40 minutes, SEP_25 + 10 minutes);
        book.createEpoch(nvda, sep25Round);
        // #when: the next week's epoch, with real prices that moved less than half
        uint64 expiry = _createOct02();
        // #then
        assertEq(expiry, OCT_09);
        assertEq(book.latestExpiry(nvda), OCT_09);
    }

    function test_refusesADelistedAsset() public {
        // #given
        vm.prank(admin);
        registry.delist(nvda);
        vm.warp(OCT_02 + 10 minutes);
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, nvda));
        // #when
        book.createEpoch(nvda, oct02Round);
    }

    function test_listsOnlyOutOfTheMoneyStrikesOnTheTickWithinTheBand() public {
        // #given
        _createOct02();
        uint256 firstCall = (oct02Reference / STRIKE_TICK + 1) * STRIKE_TICK;
        uint256 firstPut = ((oct02Reference - 1) / STRIKE_TICK) * STRIKE_TICK;
        uint256 band = (oct02Reference * STRIKE_RANGE_BPS) / 10_000;
        uint256 beyondCalls = ((oct02Reference + band) / STRIKE_TICK + 1) * STRIKE_TICK;
        // #then
        assertTrue(book.isListedStrike(nvda, OCT_09, OptionType.Call, firstCall));
        assertTrue(book.isListedStrike(nvda, OCT_09, OptionType.Put, firstPut));
        assertFalse(book.isListedStrike(nvda, OCT_09, OptionType.Call, firstPut));
        assertFalse(book.isListedStrike(nvda, OCT_09, OptionType.Put, firstCall));
        assertFalse(book.isListedStrike(nvda, OCT_09, OptionType.Call, beyondCalls));
        assertFalse(book.isListedStrike(nvda, OCT_09, OptionType.Call, firstCall + 1));
        assertFalse(book.isListedStrike(nvda, OCT_09, OptionType.Put, 0));
    }

    function test_registersASeriesOnceWithEveryTermInItsId() public {
        // #given
        _createOct02();
        uint256 strike = (oct02Reference / STRIKE_TICK + 1) * STRIKE_TICK;
        SeriesKey memory expected = SeriesKey({
            chainId: block.chainid,
            asset: nvda,
            optionType: OptionType.Call,
            strike: strike,
            expiry: OCT_09,
            windowLength: 2 hours,
            unitBasis: SeriesId.RAW_UNITS,
            exerciseStyle: ExerciseStyle.European,
            settlementType: SettlementType.Physical,
            collateralToken: nvda,
            collateralMode: CollateralMode.Idle
        });
        // #then
        vm.expectEmit(address(book));
        emit SeriesRegistered(SeriesId.id(expected), expected);
        // #when
        uint256 id = book.seriesFor(nvda, OCT_09, OptionType.Call, strike);
        uint256 again = book.seriesFor(nvda, OCT_09, OptionType.Call, strike);
        // #then
        assertEq(id, SeriesId.id(expected));
        assertEq(again, id);
        assertEq(abi.encode(book.seriesKey(id)), abi.encode(expected));
    }

    function test_putSeriesAreCollateralizedInUsdg() public {
        // #given
        _createOct02();
        uint256 strike = ((oct02Reference - 1) / STRIKE_TICK) * STRIKE_TICK;
        // #when
        uint256 id = book.seriesFor(nvda, OCT_09, OptionType.Put, strike);
        // #then
        assertEq(book.seriesKey(id).collateralToken, usdg);
    }

    function test_refusesASeriesAtAnUnlistedStrike() public {
        // #given
        _createOct02();
        uint256 itmCall = (oct02Reference / STRIKE_TICK) * STRIKE_TICK;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochBook.StrikeNotListed.selector, nvda, OCT_09, OptionType.Call, itmCall
            )
        );
        // #when
        book.seriesFor(nvda, OCT_09, OptionType.Call, itmCall);
    }

    function test_refusesASeriesForAnEpochThatDoesntExist() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.UnknownEpoch.selector, nvda, OCT_16));
        // #when
        book.seriesFor(nvda, OCT_16, OptionType.Call, STRIKE_TICK);
    }

    function test_unknownSeriesKeysRevert() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(OptionSeries.UnknownSeries.selector, 42));
        // #when
        book.seriesKey(42);
    }

    function test_longsAreTransferableErc1155Balances() public {
        // #given
        _createOct02();
        uint256 strike = (oct02Reference / STRIKE_TICK + 1) * STRIKE_TICK;
        uint256 id = book.seriesFor(nvda, OCT_09, OptionType.Call, strike);
        address maker = makeAddr("maker");
        address buyer = makeAddr("buyer");
        book.mint(maker, id, 3 * LOT);
        // #when
        vm.prank(maker);
        book.safeTransferFrom(maker, buyer, id, LOT, "");
        // #then
        assertEq(book.balanceOf(maker, id), 2 * LOT);
        assertEq(book.balanceOf(buyer, id), LOT);
        assertEq(book.totalSupply(id), 3 * LOT);
    }
}
