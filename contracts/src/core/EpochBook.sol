// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {PriceAdapter} from "../assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../calendar/SessionCalendar.sol";
import {ExternalReads} from "../libraries/ExternalReads.sol";
import {
    CollateralMode,
    ExerciseStyle,
    OptionType,
    SeriesId,
    SeriesKey,
    SettlementType
} from "../libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../liveness/LivenessCheckpoint.sol";
import {OptionSeries} from "./OptionSeries.sol";

/// @title EpochBook
/// @notice Weekly epochs per asset and their strike grids.
/// @dev An epoch is created at the latest scheduled close (its opening) with the reference price
/// at that close, and expires at the next scheduled close. It copies the asset's grid and the
/// window length, so later changes to the registry or calendar can't touch a live epoch. Creation
/// needs evidence from the half hour before the opening: no liveness gap, and keeper observations
/// of the asset's oracle that never saw a pause, the last one within five minutes of the close.
abstract contract EpochBook is OptionSeries, ReentrancyGuardTransient {
    uint256 internal constant BPS = 10_000;
    uint64 public constant LIVENESS_LOOKBACK = 30 minutes;
    uint64 public constant CLOSE_OBSERVATION_RECENCY = 5 minutes;
    uint256 public constant REFERENCE_RECENCY = 8 days;
    uint32 public constant WINDOW_LENGTH = 2 hours;

    struct Epoch {
        uint64 opening;
        uint64 expiry;
        uint32 windowLength;
        uint64 referenceUpdatedAt;
        uint80 referenceRound;
        uint256 referencePrice;
        uint256 rawUnit;
        uint256 lot;
        uint256 priceTick;
        uint256 strikeTick;
        uint16 strikeRangeBps;
    }

    /// @param lastClear The latest observation that saw the oracle unpaused.
    /// @param pausedSeen Whether any observation saw it paused.
    struct CloseObservation {
        uint64 lastClear;
        bool pausedSeen;
    }

    SessionCalendar public immutable calendar;
    StockTokenRegistry public immutable registry;
    PriceAdapter public immutable priceAdapter;
    LivenessCheckpoint public immutable liveness;
    address public immutable usdg;

    mapping(address asset => mapping(uint64 expiry => Epoch)) private _epochs;
    mapping(address asset => uint64) public latestExpiry;
    mapping(address asset => mapping(uint64 close => CloseObservation)) private _observations;

    event EpochCreated(
        address indexed asset,
        uint64 indexed expiry,
        uint64 opening,
        uint256 referencePrice,
        uint80 referenceRound,
        uint64 referenceUpdatedAt,
        uint32 windowLength
    );
    event OraclePauseObserved(address indexed asset, uint64 indexed close, uint64 observedAt);

    error CreationWindowClosed(uint64 opening, uint64 deadline);
    error EpochExists(address asset, uint64 expiry);
    error LivenessGapAtClose(uint64 opening, uint64 gapSeconds);
    error NotNearAClose(uint64 close);
    error OraclePausedAtClose(address asset, uint64 close);
    error CloseNotObserved(address asset, uint64 close);
    error UnknownEpoch(address asset, uint64 expiry);
    error StrikeNotListed(address asset, uint64 expiry, OptionType optionType, uint256 strike);

    constructor(
        SessionCalendar calendar_,
        StockTokenRegistry registry_,
        PriceAdapter priceAdapter_,
        LivenessCheckpoint liveness_
    ) {
        calendar = calendar_;
        registry = registry_;
        priceAdapter = priceAdapter_;
        liveness = liveness_;
        usdg = address(registry_.usdg());
    }

    /// @notice Opens the epoch that runs from the latest scheduled close to the next one.
    /// @param roundHint The feed's last round at or before that close, found offchain.
    function createEpoch(address asset, uint80 roundHint)
        external
        nonReentrant
        returns (uint64 expiry)
    {
        liveness.checkpoint();
        _requireNotHalted();
        StockTokenRegistry.Asset memory config = registry.asset(asset);
        SessionCalendar.Boundary memory boundary =
            calendar.latestBoundaryAtOrBefore(uint64(block.timestamp));
        uint64 opening = boundary.close;
        if (block.timestamp >= boundary.creationDeadline) {
            revert CreationWindowClosed(opening, boundary.creationDeadline);
        }
        expiry = calendar.nextCloseAfter(opening);
        if (_epochs[asset][expiry].expiry != 0) revert EpochExists(asset, expiry);
        uint64 gap = liveness.gapOverlap(opening - LIVENESS_LOOKBACK, opening);
        if (gap != 0) revert LivenessGapAtClose(opening, gap);
        _requireClearAtClose(asset, opening);

        Epoch storage previous = _epochs[asset][latestExpiry[asset]];
        uint256 previousReference = previous.expiry != 0
            && previous.opening + REFERENCE_RECENCY >= opening
            ? previous.referencePrice
            : 0;
        (uint256 price, uint80 round, uint64 updatedAt) =
            priceAdapter.referencePrice(asset, opening, roundHint, previousReference);

        _epochs[asset][expiry] = Epoch({
            opening: opening,
            expiry: expiry,
            windowLength: WINDOW_LENGTH,
            referenceUpdatedAt: updatedAt,
            referenceRound: round,
            referencePrice: price,
            rawUnit: config.rawUnit,
            lot: config.lot,
            priceTick: config.priceTick,
            strikeTick: config.strikeTick,
            strikeRangeBps: config.strikeRangeBps
        });
        if (expiry > latestExpiry[asset]) latestExpiry[asset] = expiry;
        emit EpochCreated(asset, expiry, opening, price, round, updatedAt, WINDOW_LENGTH);
    }

    /// @notice Records whether the asset's oracle is paused, for the close coming up within
    /// LIVENESS_LOOKBACK. The keeper calls it every minute in that stretch for each listed asset,
    /// and anyone may call it.
    function observeClose(address asset) external nonReentrant {
        liveness.checkpoint();
        if (!registry.isListed(asset)) revert StockTokenRegistry.NotListed(asset);
        uint64 now_ = uint64(block.timestamp);
        uint64 close = calendar.nextCloseAfter(now_ - 1);
        if (close - now_ > LIVENESS_LOOKBACK) revert NotNearAClose(close);
        CloseObservation storage seen = _observations[asset][close];
        if (ExternalReads.oraclePaused(asset)) {
            seen.pausedSeen = true;
            emit OraclePauseObserved(asset, close, now_);
        } else {
            seen.lastClear = now_;
        }
    }

    function closeObservation(address asset, uint64 close)
        external
        view
        returns (CloseObservation memory)
    {
        return _observations[asset][close];
    }

    function epoch(address asset, uint64 expiry) external view returns (Epoch memory) {
        return _epoch(asset, expiry);
    }

    function isListedStrike(address asset, uint64 expiry, OptionType optionType, uint256 strike)
        external
        view
        returns (bool)
    {
        return _isListedStrike(_epoch(asset, expiry), optionType, strike);
    }

    /// @dev Reverts while an emergency halt is active. MarketGuard implements it.
    function _requireNotHalted() internal view virtual;

    /// @dev A pause seen at any point in the lookback refuses the week, as does no unpaused
    /// observation in the last CLOSE_OBSERVATION_RECENCY before the close.
    function _requireClearAtClose(address asset, uint64 close) private view {
        CloseObservation memory seen = _observations[asset][close];
        if (seen.pausedSeen) revert OraclePausedAtClose(asset, close);
        if (seen.lastClear + CLOSE_OBSERVATION_RECENCY < close) {
            revert CloseNotObserved(asset, close);
        }
    }

    function _epoch(address asset, uint64 expiry) internal view returns (Epoch storage e) {
        e = _epochs[asset][expiry];
        if (e.expiry == 0) revert UnknownEpoch(asset, expiry);
    }

    /// @dev Out-of-the-money strikes on the tick, within the band around the reference price.
    function _isListedStrike(Epoch storage e, OptionType optionType, uint256 strike)
        internal
        view
        returns (bool)
    {
        if (strike == 0 || strike % e.strikeTick != 0) return false;
        uint256 band = (e.referencePrice * e.strikeRangeBps) / BPS;
        if (optionType == OptionType.Call) {
            return strike > e.referencePrice && strike <= e.referencePrice + band;
        }
        return strike < e.referencePrice && strike + band >= e.referencePrice;
    }

    /// @dev Registers the series on first use. Reverts unless the strike is listed for the epoch.
    function _seriesFor(address asset, uint64 expiry, OptionType optionType, uint256 strike)
        internal
        returns (uint256 id)
    {
        Epoch storage e = _epoch(asset, expiry);
        if (!_isListedStrike(e, optionType, strike)) {
            revert StrikeNotListed(asset, expiry, optionType, strike);
        }
        id = _register(
            SeriesKey({
                chainId: block.chainid,
                asset: asset,
                optionType: optionType,
                strike: strike,
                expiry: expiry,
                windowLength: e.windowLength,
                unitBasis: SeriesId.RAW_UNITS,
                exerciseStyle: ExerciseStyle.European,
                settlementType: SettlementType.Physical,
                collateralToken: optionType == OptionType.Call ? asset : usdg,
                collateralMode: CollateralMode.Idle
            })
        );
    }
}
