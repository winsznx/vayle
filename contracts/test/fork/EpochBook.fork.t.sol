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
import {ChainActors, IOracleAdmin} from "../utils/ChainActors.sol";
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
        _runKeeper(book, OCT_02, OCT_02 - KEEPER_LEAD, OCT_02 + 10 minutes);
        return book.createEpoch(stock, oct02Round);
    }

    function test_createsTheEpochFromTheLatestCloseToTheNext() public {
        // #given
        _runKeeper(book, OCT_02, OCT_02 - KEEPER_LEAD, OCT_02 + 10 minutes);
        (,, uint256 updatedAt) = _lastRoundAtOrBefore(OCT_02);
        // #then
        vm.expectEmit(address(book));
        emit EpochCreated(
            stock, OCT_09, OCT_02, oct02Reference, oct02Round, uint64(updatedAt), 2 hours
        );
        // #when
        uint64 expiry = book.createEpoch(stock, oct02Round);
        // #then
        EpochBook.Epoch memory e = book.epoch(stock, expiry);
        assertEq(expiry, OCT_09);
        assertEq(e.opening, OCT_02);
        assertEq(e.referencePrice, oct02Reference);
        assertEq(e.windowLength, 2 hours);
        assertEq(e.lot, lot);
        assertEq(e.strikeTick, strikeTick);
        assertEq(book.latestExpiry(stock), OCT_09);
    }

    function test_refusesOnceTheBoundarysCreationDeadlineHasPassed() public {
        // #given
        _runKeeper(book, OCT_02, OCT_02 - KEEPER_LEAD, OCT_02 + 10 minutes);
        vm.warp(OCT_05_OPEN);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(EpochBook.CreationWindowClosed.selector, OCT_02, OCT_05_OPEN)
        );
        // #when
        book.createEpoch(stock, oct02Round);
    }

    function test_createsUntilTheSecondBeforeTheDeadline() public {
        // #given
        _runKeeper(book, OCT_02, OCT_02 - KEEPER_LEAD, OCT_02 + 10 minutes);
        vm.warp(OCT_05_OPEN - 1);
        // #when
        uint64 expiry = book.createEpoch(stock, oct02Round);
        // #then
        assertEq(expiry, OCT_09);
    }

    function test_aFirstPingInsideTheLookbackRefusesTheWeek() public {
        // #given: nothing pinged since deployment, and the keeper's first ping lands one second
        // into the lookback, so the quiet stretch it ends overlaps the lookback by one second
        _runKeeper(book, OCT_02, OCT_02 - 30 minutes + 1, OCT_02 + 10 minutes);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(EpochBook.LivenessGapAtClose.selector, OCT_02, uint64(1))
        );
        // #when
        book.createEpoch(stock, oct02Round);
    }

    function test_theKeeperLeadAbsorbsAFirstPingFourteenMinutesLate() public {
        // #given
        _runKeeper(book, OCT_02, OCT_02 - KEEPER_LEAD + 14 minutes, OCT_02 + 10 minutes);
        // #when
        uint64 expiry = book.createEpoch(stock, oct02Round);
        // #then
        assertEq(expiry, OCT_09);
    }

    function test_refusesWhenTheOracleWasPausedInTheLookbackEvenAfterItResumed() public {
        // #given: the real pauser pauses NVDA's oracle ten minutes before the close and
        // unpauses it five minutes after
        _runKeeper(book, OCT_02, OCT_02 - KEEPER_LEAD, OCT_02 - 11 minutes);
        vm.prank(ChainActors.ORACLE_PAUSER);
        IOracleAdmin(stock).pauseOracle();
        _runKeeper(book, OCT_02, OCT_02 - 10 minutes, OCT_02 + 5 minutes);
        vm.prank(ChainActors.ORACLE_PAUSER);
        IOracleAdmin(stock).unpauseOracle();
        vm.warp(OCT_02 + 10 minutes);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(EpochBook.OraclePausedAtClose.selector, stock, OCT_02)
        );
        // #when
        book.createEpoch(stock, oct02Round);
    }

    function test_refusesWithoutAnyOracleObservation() public {
        // #given: liveness pings only
        _keepAlive(OCT_02 - KEEPER_LEAD, OCT_02 + 10 minutes);
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.CloseNotObserved.selector, stock, OCT_02));
        // #when
        book.createEpoch(stock, oct02Round);
    }

    function test_refusesWhenTheLastObservationIsOlderThanFiveMinutesAtTheClose() public {
        // #given: observations stop six minutes before the close, pings continue
        _runKeeper(book, OCT_02, OCT_02 - KEEPER_LEAD, OCT_02 - 6 minutes);
        _keepAlive(OCT_02 - 5 minutes, OCT_02 + 10 minutes);
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.CloseNotObserved.selector, stock, OCT_02));
        // #when
        book.createEpoch(stock, oct02Round);
    }

    function test_anObservationRecordsAnUnpausedOracleForTheComingClose() public {
        // #given
        vm.warp(OCT_02 - 1 minutes);
        // #when
        book.observeClose(stock);
        // #then
        EpochBook.CloseObservation memory seen = book.closeObservation(stock, OCT_02);
        assertEq(seen.lastClear, OCT_02 - 1 minutes);
        assertFalse(seen.pausedSeen);
    }

    function test_anObservationAtTheCloseCountsForThatClose() public {
        // #given
        vm.warp(OCT_02);
        // #when
        book.observeClose(stock);
        // #then
        assertEq(book.closeObservation(stock, OCT_02).lastClear, OCT_02);
    }

    function test_refusesAnObservationOutsideTheLookback() public {
        // #given
        vm.warp(OCT_02 - 30 minutes - 1);
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.NotNearAClose.selector, OCT_02));
        // #when
        book.observeClose(stock);
    }

    function test_refusesAnObservationOfAnUnlistedAsset() public {
        // #given
        vm.warp(OCT_02 - 1 minutes);
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, usdg));
        // #when
        book.observeClose(usdg);
    }

    function test_refusesASecondEpochForTheSameExpiry() public {
        // #given
        _createOct02();
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.EpochExists.selector, stock, OCT_09));
        // #when
        book.createEpoch(stock, oct02Round);
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
        book.createEpoch(stock, oct02Round);
    }

    function test_checksTheJumpAgainstARecentPreviousEpoch() public {
        // #given: an epoch created at the Sep 25 close
        (uint80 sep25Round,,) = _lastRoundAtOrBefore(SEP_25);
        _runKeeper(book, SEP_25, SEP_25 - KEEPER_LEAD, SEP_25 + 10 minutes);
        book.createEpoch(stock, sep25Round);
        // #when: the next week's epoch, with real prices that moved less than half
        uint64 expiry = _createOct02();
        // #then
        assertEq(expiry, OCT_09);
        assertEq(book.latestExpiry(stock), OCT_09);
    }

    function test_refusesADelistedAsset() public {
        // #given
        vm.prank(admin);
        registry.delist(stock);
        vm.warp(OCT_02 + 10 minutes);
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, stock));
        // #when
        book.createEpoch(stock, oct02Round);
    }

    function test_listsOnlyOutOfTheMoneyStrikesOnTheTickWithinTheBand() public {
        // #given
        _createOct02();
        uint256 firstCall = (oct02Reference / strikeTick + 1) * strikeTick;
        uint256 firstPut = ((oct02Reference - 1) / strikeTick) * strikeTick;
        uint256 band = (oct02Reference * strikeRangeBps) / 10_000;
        uint256 beyondCalls = ((oct02Reference + band) / strikeTick + 1) * strikeTick;
        // #then
        assertTrue(book.isListedStrike(stock, OCT_09, OptionType.Call, firstCall));
        assertTrue(book.isListedStrike(stock, OCT_09, OptionType.Put, firstPut));
        assertFalse(book.isListedStrike(stock, OCT_09, OptionType.Call, firstPut));
        assertFalse(book.isListedStrike(stock, OCT_09, OptionType.Put, firstCall));
        assertFalse(book.isListedStrike(stock, OCT_09, OptionType.Call, beyondCalls));
        assertFalse(book.isListedStrike(stock, OCT_09, OptionType.Call, firstCall + 1));
        assertFalse(book.isListedStrike(stock, OCT_09, OptionType.Put, 0));
    }

    function test_registersASeriesOnceWithEveryTermInItsId() public {
        // #given
        _createOct02();
        uint256 strike = (oct02Reference / strikeTick + 1) * strikeTick;
        SeriesKey memory expected = SeriesKey({
            chainId: block.chainid,
            asset: stock,
            optionType: OptionType.Call,
            strike: strike,
            expiry: OCT_09,
            windowLength: 2 hours,
            unitBasis: SeriesId.RAW_UNITS,
            exerciseStyle: ExerciseStyle.European,
            settlementType: SettlementType.Physical,
            collateralToken: stock,
            collateralMode: CollateralMode.Idle
        });
        // #then
        vm.expectEmit(address(book));
        emit SeriesRegistered(SeriesId.id(expected), expected);
        // #when
        uint256 id = book.seriesFor(stock, OCT_09, OptionType.Call, strike);
        uint256 again = book.seriesFor(stock, OCT_09, OptionType.Call, strike);
        // #then
        assertEq(id, SeriesId.id(expected));
        assertEq(again, id);
        assertEq(abi.encode(book.seriesKey(id)), abi.encode(expected));
    }

    function test_putSeriesAreCollateralizedInUsdg() public {
        // #given
        _createOct02();
        uint256 strike = ((oct02Reference - 1) / strikeTick) * strikeTick;
        // #when
        uint256 id = book.seriesFor(stock, OCT_09, OptionType.Put, strike);
        // #then
        assertEq(book.seriesKey(id).collateralToken, usdg);
    }

    function test_refusesASeriesAtAnUnlistedStrike() public {
        // #given
        _createOct02();
        uint256 itmCall = (oct02Reference / strikeTick) * strikeTick;
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                EpochBook.StrikeNotListed.selector, stock, OCT_09, OptionType.Call, itmCall
            )
        );
        // #when
        book.seriesFor(stock, OCT_09, OptionType.Call, itmCall);
    }

    function test_refusesASeriesForAnEpochThatDoesntExist() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(EpochBook.UnknownEpoch.selector, stock, OCT_16));
        // #when
        book.seriesFor(stock, OCT_16, OptionType.Call, strikeTick);
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
        uint256 strike = (oct02Reference / strikeTick + 1) * strikeTick;
        uint256 id = book.seriesFor(stock, OCT_09, OptionType.Call, strike);
        address maker = makeAddr("maker");
        address buyer = makeAddr("buyer");
        book.mint(maker, id, 3 * lot);
        // #when
        vm.prank(maker);
        book.safeTransferFrom(maker, buyer, id, lot, "");
        // #then
        assertEq(book.balanceOf(maker, id), 2 * lot);
        assertEq(book.balanceOf(buyer, id), lot);
        assertEq(book.totalSupply(id), 3 * lot);
    }
}
