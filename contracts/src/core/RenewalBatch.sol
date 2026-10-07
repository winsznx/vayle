// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SeriesKey} from "../libraries/SeriesId.sol";
import {Units} from "../libraries/Units.sol";
import {QuoteSettlement} from "./QuoteSettlement.sol";

/// @title RenewalBatch
/// @notice The weekly batch that renews standing orders at one clearing price.
/// @dev After each boundary close, makers publish signed bids for the new week's series in a fixed
/// window. A batch then fills every eligible order in the series' bucket (asset, side, strike) at
/// the best bid, cut pro rata when the bid or the series cap is short. Anyone runs it in chunks:
/// open, count every idle order in the bucket, seal (the maker's premium goes into escrow), fill.
/// Counting must cover the whole bucket in increasing order ID before anything fills, so whoever
/// runs it can't leave a holder out, and one ratio fixed at the seal applies to everyone. Orders in
/// the bucket can't be edited, cancelled or filled by quote from the bid window until the batch
/// ends.
abstract contract RenewalBatch is QuoteSettlement {
    uint64 public constant BID_WINDOW = 2 hours;

    enum Phase {
        None,
        Counting,
        Filling,
        Done
    }

    struct Bid {
        address maker;
        uint256 premium;
        uint256 amount;
        uint16 maxFeeBps;
    }

    /// @param maxOrderId Orders placed after the batch opened aren't part of it.
    /// @param total The bucket's idle size when the batch opened.
    /// @param eligible Counted size whose minimum premium is at or under the bid.
    /// @param capacity What the batch writes at most: the bid, the eligible size and the series cap.
    /// @param processed Eligible size handled while filling.
    /// @param cursor The last order ID handled in the current phase.
    struct Batch {
        Phase phase;
        uint16 feeBps;
        uint256 maxOrderId;
        uint256 total;
        uint256 counted;
        uint256 eligible;
        uint256 capacity;
        uint256 processed;
        uint256 written;
        uint256 escrow;
        uint256 cursor;
    }

    mapping(uint256 series => Bid) private _bestBids;
    mapping(uint256 series => Batch) private _batches;

    event BidSubmitted(
        uint256 indexed series,
        bytes32 indexed digest,
        address indexed maker,
        uint256 premium,
        uint256 amount
    );
    /// @param teamOperated Whether the maker whose bid the batch fills at is operated by the team,
    /// so every batch fill is tagged the way a quote fill is.
    event BatchOpened(
        uint256 indexed series,
        address indexed maker,
        uint256 premium,
        uint256 total,
        bool teamOperated
    );
    event OrderSkipped(
        uint256 indexed orderId, uint256 indexed series, uint256 minPremium, uint256 premium
    );
    event BatchSealed(uint256 indexed series, uint256 eligible, uint256 capacity, uint256 escrow);
    event BatchFilled(
        uint256 indexed series, uint256 indexed orderId, uint256 amount, uint256 premiumValue
    );
    event BatchDone(uint256 indexed series, uint256 written, uint256 fee, uint256 refund);

    error NotCurrentSeries(uint256 series);
    error OutsideBidWindow(uint256 series, uint64 opens, uint64 closes);
    error BatchAlreadyOpened(uint256 series);
    error NoBid(uint256 series);
    error BucketStillAttached(uint256 series, uint256 attached);
    error WrongPhase(uint256 series, Phase phase);
    error OrdersOutOfOrder(uint256 id, uint256 cursor);
    error OrderNotInBatch(uint256 id);
    error BatchStillRunning(uint256 series);

    /// @notice Publishes a maker's signed bid for a series of the asset's current week. The
    /// highest premium becomes the batch's price, and the earlier bid wins a tie. A bid is used
    /// up when submitted, so it can't also be filled by quote.
    function submitBid(Quote calldata quote, bytes calldata signature) external nonReentrant {
        liveness.checkpoint();
        SeriesKey storage key = _key(quote.series);
        Epoch storage e = _currentEpoch(quote.series, key);
        uint64 opens = _bidOpen(e);
        if (block.timestamp < opens || block.timestamp >= e.batchDeadline) {
            revert OutsideBidWindow(quote.series, opens, e.batchDeadline);
        }
        if (_batches[quote.series].phase != Phase.None) revert BatchAlreadyOpened(quote.series);
        if (quote.taker != address(0)) revert TakerMismatch(quote.taker, address(0));
        bytes32 digest = _authorizeQuote(quote, signature, key);
        uint256 used = quoteFilled[digest];
        if (used != 0) revert QuoteOverfilled(digest, used, quote.maxAmount, quote.maxAmount);
        _requirePriced(quote, key);
        quoteFilled[digest] = quote.maxAmount;
        emit BidSubmitted(quote.series, digest, quote.maker, quote.premium, quote.maxAmount);
        Bid storage best = _bestBids[quote.series];
        if (best.maker == address(0) || quote.premium > best.premium) {
            (best.maker, best.premium, best.amount, best.maxFeeBps) =
            (quote.maker, quote.premium, quote.maxAmount, quote.maxFeeBps);
        }
    }

    /// @notice Starts the series' batch with the best bid once the bid window has run. Every order
    /// attached to last week's series must be settled first.
    function openBatch(uint256 series) external nonReentrant {
        liveness.checkpoint();
        SeriesKey storage key = _key(series);
        Epoch storage e = _currentEpoch(series, key);
        _requireFillsOpen(key.asset);
        uint64 opens = _bidOpen(e) + BID_WINDOW;
        if (block.timestamp < opens || block.timestamp >= e.batchDeadline) {
            revert OutsideBidWindow(series, opens, e.batchDeadline);
        }
        Batch storage b = _batches[series];
        if (b.phase != Phase.None) revert BatchAlreadyOpened(series);
        Bid storage bid = _bestBids[series];
        if (bid.maker == address(0)) revert NoBid(series);
        uint256 attached = attachedOrders[key.asset][key.optionType][key.strike];
        if (attached != 0) revert BucketStillAttached(series, attached);
        b.maxOrderId = orderCount;
        b.total = idleSize[key.asset][key.optionType][key.strike];
        b.phase = b.total == 0 ? Phase.Done : Phase.Counting;
        emit BatchOpened(series, bid.maker, bid.premium, b.total, teamOperated[bid.maker]);
    }

    /// @notice Counts orders of the bucket, in increasing ID. Once every idle order is counted the
    /// batch seals: capacity is fixed and the maker's premium and fee go into escrow.
    function countBatch(uint256 series, uint256[] calldata ids) external nonReentrant {
        liveness.checkpoint();
        SeriesKey storage key = _key(series);
        Batch storage b = _requirePhase(series, Phase.Counting);
        Epoch storage e = _epoch(key.asset, key.expiry);
        if (block.timestamp >= e.batchDeadline) {
            revert OutsideBidWindow(series, _bidOpen(e) + BID_WINDOW, e.batchDeadline);
        }
        uint256 premium = _bestBids[series].premium;
        uint256 cursor = b.cursor;
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (id <= cursor || id > b.maxOrderId) revert OrdersOutOfOrder(id, cursor);
            Order storage o = _inBucket(id, key);
            b.counted += o.size;
            if (o.minPremium <= premium) b.eligible += o.size;
            else emit OrderSkipped(id, series, o.minPremium, premium);
            cursor = id;
        }
        b.cursor = cursor;
        if (b.counted == b.total) _seal(series, key, e, b);
    }

    /// @notice Fills counted eligible orders, in increasing ID, each with the same share of its
    /// size. Anyone may call it, so a sealed batch always finishes.
    function fillBatch(uint256 series, uint256[] calldata ids) external nonReentrant {
        liveness.checkpoint();
        SeriesKey storage key = _key(series);
        Batch storage b = _requirePhase(series, Phase.Filling);
        _requireFillsOpen(key.asset);
        Bid storage bid = _bestBids[series];
        Epoch storage e = _epoch(key.asset, key.expiry);
        (, uint256 fillCap) = _batchLimits(key.asset, series);
        uint256 cursor = b.cursor;
        uint256 minted = 0;
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (id <= cursor || id > b.maxOrderId) revert OrdersOutOfOrder(id, cursor);
            Order storage o = _inBucket(id, key);
            if (o.minPremium > bid.premium) revert OrderNotInBatch(id);
            uint256 amount = Math.min(Math.mulDiv(o.size, b.capacity, b.eligible), fillCap);
            amount -= amount % e.lot;
            b.processed += o.size;
            cursor = id;
            if (amount == 0) continue;
            _commit(id, series, amount);
            uint256 value = Units.valueExact(amount, bid.premium, e.rawUnit);
            b.written += amount;
            minted += amount;
            emit BatchFilled(series, id, amount, value);
            _credit(o.owner, usdg, value);
        }
        b.cursor = cursor;
        if (minted != 0) _mint(bid.maker, series, minted, "");
        if (b.processed == b.eligible) _finish(series, e, b);
    }

    /// @notice Ends a sealed batch that can't fill: after the deadline while new positions are
    /// refused, or once the series has expired. Unfilled orders unfreeze, and the maker's unused
    /// escrow is returned.
    function closeBatch(uint256 series) external nonReentrant {
        liveness.checkpoint();
        _requireNotHalted();
        SeriesKey storage key = _key(series);
        Batch storage b = _requirePhase(series, Phase.Filling);
        Epoch storage e = _epoch(key.asset, key.expiry);
        bool stuck = block.timestamp >= e.batchDeadline && _fillsBlocked(key.asset);
        if (!stuck && block.timestamp < key.expiry) revert BatchStillRunning(series);
        _finish(series, e, b);
    }

    function bestBid(uint256 series) external view returns (Bid memory) {
        return _bestBids[series];
    }

    function batchOf(uint256 series) external view returns (Batch memory) {
        return _batches[series];
    }

    /// @notice Whether the order is held by a renewal batch right now.
    function frozen(uint256 id) external view returns (bool) {
        return _frozen(_orderStorage(id));
    }

    /// @dev Pauses, caps and the oracle flag for fills. MarketGuard implements these.
    function _batchLimits(address asset, uint256 series)
        internal
        view
        virtual
        returns (uint256 seriesRoom, uint256 fillSize);
    function _fillsBlocked(address asset) internal view virtual returns (bool);

    function _requireNotFrozen(uint256 id, Order storage order) internal view override {
        if (_frozen(order)) revert OrderFrozen(id);
    }

    /// @dev An idle order whose target is listed this week is frozen from the bid window until its
    /// series' batch is done or the deadline passes unsealed. A sealed batch holds it until done.
    function _frozen(Order storage o) internal view returns (bool) {
        if (o.status != OrderStatus.Active || o.series != 0) return false;
        uint64 expiry = latestExpiry[o.asset];
        if (expiry == 0) return false;
        Epoch storage e = _epoch(o.asset, expiry);
        if (!_isListedStrike(e, o.side, o.target)) return false;
        Phase phase = _batches[_seriesIdIn(e, o.asset, o.side, o.target)].phase;
        if (phase == Phase.Filling) return true;
        if (phase == Phase.Done) return false;
        return block.timestamp >= _bidOpen(e) && block.timestamp < e.batchDeadline;
    }

    /// @dev Capacity is the bid, the eligible size and the series cap's room, in whole lots. The
    /// escrow covers premium and fee on all of it, at the fee rate in force now.
    function _seal(uint256 series, SeriesKey storage key, Epoch storage e, Batch storage b)
        private
    {
        Bid storage bid = _bestBids[series];
        (uint256 seriesRoom,) = _batchLimits(key.asset, series);
        uint256 capacity = Math.min(Math.min(bid.amount, b.eligible), seriesRoom);
        capacity -= capacity % e.lot;
        b.capacity = capacity;
        b.cursor = 0;
        if (capacity == 0) {
            b.phase = Phase.Done;
            emit BatchSealed(series, b.eligible, 0, 0);
            emit BatchDone(series, 0, 0, 0);
            return;
        }
        uint16 rate = feeBps;
        if (rate > bid.maxFeeBps) revert FeeAboveQuote(rate, bid.maxFeeBps);
        uint256 premiumValue = Units.valueExact(capacity, bid.premium, e.rawUnit);
        uint256 escrow = premiumValue + Units.fee(premiumValue, rate);
        (b.feeBps, b.escrow, b.phase) = (rate, escrow, Phase.Filling);
        emit BatchSealed(series, b.eligible, capacity, escrow);
        _pull(usdg, bid.maker, escrow);
    }

    /// @dev The fee on what was written goes to the recipient and the rest of the escrow back to
    /// the maker. Holders were credited as their orders filled.
    function _finish(uint256 series, Epoch storage e, Batch storage b) private {
        Bid storage bid = _bestBids[series];
        uint256 premiumValue = Units.valueExact(b.written, bid.premium, e.rawUnit);
        uint256 fee = Units.fee(premiumValue, b.feeBps);
        uint256 refund = b.escrow - premiumValue - fee;
        b.phase = Phase.Done;
        emit BatchDone(series, b.written, fee, refund);
        _credit(feeRecipient, usdg, fee);
        _credit(bid.maker, usdg, refund);
    }

    function _currentEpoch(uint256 series, SeriesKey storage key)
        private
        view
        returns (Epoch storage)
    {
        if (key.expiry != latestExpiry[key.asset]) revert NotCurrentSeries(series);
        return _epoch(key.asset, key.expiry);
    }

    /// @dev The bid window opens when the expiring week's exercise window has run, which has the
    /// same length as this epoch's.
    function _bidOpen(Epoch storage e) private view returns (uint64) {
        return e.opening + e.windowLength;
    }

    function _requirePhase(uint256 series, Phase phase) private view returns (Batch storage b) {
        b = _batches[series];
        if (b.phase != phase) revert WrongPhase(series, b.phase);
    }

    function _inBucket(uint256 id, SeriesKey storage key) private view returns (Order storage o) {
        o = _orderStorage(id);
        if (
            o.status != OrderStatus.Active || o.series != 0 || o.asset != key.asset
                || o.side != key.optionType || o.target != key.strike
        ) {
            revert OrderNotInBatch(id);
        }
    }
}
