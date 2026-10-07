// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StockTokenRegistry} from "../assets/StockTokenRegistry.sol";
import {OptionType, SeriesKey} from "../libraries/SeriesId.sol";
import {Units} from "../libraries/Units.sol";
import {EpochBook} from "./EpochBook.sol";

/// @title CollateralVault
/// @notice Holder orders, their collateral, and one collateral pool per series.
/// @dev An order sells the asset at a target (written as calls) or buys it at a target (written as
/// puts). It's fully collateralized when placed and runs until cancelled. Every payout becomes a
/// claimable balance the owner withdraws, so a blocked party can only stall its own claim.
abstract contract CollateralVault is EpochBook {
    using SafeERC20 for IERC20;

    enum OrderStatus {
        None,
        Active,
        Cancelled,
        Closed
    }

    struct Order {
        address owner;
        address asset;
        OptionType side;
        OrderStatus status;
        bool flip;
        uint256 target;
        uint256 minPremium;
        uint256 flipTarget;
        uint256 rawUnit;
        uint256 lot;
        uint256 size;
        uint256 committed;
        uint256 series;
    }

    struct Pool {
        uint256 written;
        uint256 exercised;
        uint256 collateral;
        uint256 proceeds;
        uint256 remainingShares;
        bool settled;
    }

    struct OrderParams {
        address asset;
        OptionType side;
        uint256 target;
        uint256 minPremium;
        uint256 size;
        bool flip;
        uint256 flipTarget;
    }

    /// @notice An idle order's new terms. Its asset and side never change.
    struct AmendParams {
        uint256 target;
        uint256 minPremium;
        uint256 size;
        bool flip;
        uint256 flipTarget;
    }

    uint256 public orderCount;
    mapping(uint256 id => Order) private _orders;
    mapping(uint256 series => Pool) private _pools;
    mapping(address owner => mapping(address token => uint256)) public claimable;
    /// @notice The total size of active orders per asset and side, in raw units.
    mapping(address asset => mapping(OptionType side => uint256)) public openSize;
    /// @notice The same total per owner.
    mapping(address owner => mapping(address asset => mapping(OptionType side => uint256))) public
        walletSize;
    /// @notice Size of Active orders not attached to a series, per bucket: asset, side and target.
    /// This is what a renewal batch for the bucket can write.
    mapping(address asset => mapping(OptionType side => mapping(uint256 target => uint256))) public
        idleSize;
    /// @notice Orders attached to a series and not yet settled, per bucket.
    mapping(address asset => mapping(OptionType side => mapping(uint256 target => uint256))) public
        attachedOrders;

    event OrderPlaced(
        uint256 indexed id,
        address indexed owner,
        address indexed asset,
        OptionType side,
        uint256 target,
        uint256 minPremium,
        uint256 size,
        bool flip,
        uint256 flipTarget
    );
    event OrderUpdated(uint256 indexed id, uint256 minPremium, bool flip, uint256 flipTarget);
    /// @notice An idle order's terms after an amend. It keeps its ID, asset, side and owner.
    event OrderAmended(
        uint256 indexed id,
        uint256 target,
        uint256 minPremium,
        uint256 size,
        bool flip,
        uint256 flipTarget
    );
    event OrderCancelled(uint256 indexed id, uint256 released);
    event OrderCommitted(uint256 indexed id, uint256 indexed series, uint256 amount);
    event OrderSettled(
        uint256 indexed id,
        uint256 indexed series,
        uint256 collateralBack,
        uint256 proceeds,
        uint256 renewedSize
    );
    event OrderClosed(uint256 indexed id);
    event OrderFlipped(uint256 indexed fromId, uint256 indexed toId);
    event Exercised(uint256 indexed series, address indexed exerciser, uint256 amount);
    event SeriesFinalized(uint256 indexed series, uint256 written, uint256 exercised);
    event Credited(address indexed owner, address indexed token, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);

    error UnexpectedTransferAmount(address token, uint256 expected, uint256 received);
    error NotOrderOwner(uint256 id, address caller);
    error OrderNotActive(uint256 id);
    error UnknownOrder(uint256 id);
    error SeriesMismatch(uint256 orderId, uint256 series);
    error SeriesClosed(uint256 series);
    error SeriesSettled(uint256 series);
    error SeriesNotSettled(uint256 series);
    error ExceedsUncommitted(uint256 orderId, uint256 amount, uint256 uncommitted);
    error ExceedsWritten(uint256 series, uint256 amount, uint256 outstanding);
    error NothingToSettle(uint256 orderId);
    error InsufficientClaimable(address owner, address token, uint256 amount, uint256 available);
    error OrderFrozen(uint256 id);
    error OrderAttached(uint256 id, uint256 series);
    error TargetFrozen(uint256 id, uint256 target);

    function placeOrder(OrderParams calldata p) external nonReentrant returns (uint256 id) {
        liveness.checkpoint();
        StockTokenRegistry.Asset memory a = registry.asset(p.asset);
        Units.requireLots(p.size, a.lot);
        _requireStrike(p.target, a.strikeTick);
        Units.requireOnTick(p.minPremium, a.priceTick);
        if (p.flip) _requireStrike(p.flipTarget, a.strikeTick);
        _checkPlacement(msg.sender, p.asset, p.side, p.size);

        id = ++orderCount;
        _orders[id] = Order({
            owner: msg.sender,
            asset: p.asset,
            side: p.side,
            status: OrderStatus.Active,
            flip: p.flip,
            target: p.target,
            minPremium: p.minPremium,
            flipTarget: p.flip ? p.flipTarget : 0,
            rawUnit: a.rawUnit,
            lot: a.lot,
            size: 0,
            committed: 0,
            series: 0
        });
        _grow(_orders[id], p.size);
        idleSize[p.asset][p.side][p.target] += p.size;
        emit OrderPlaced(
            id, msg.sender, p.asset, p.side, p.target, p.minPremium, p.size, p.flip, p.flipTarget
        );
        (address token, uint256 amount) = _collateralOf(_orders[id], p.size);
        _pull(token, msg.sender, amount);
    }

    function updateOrder(uint256 id, uint256 minPremium, bool flip, uint256 flipTarget)
        external
        nonReentrant
    {
        liveness.checkpoint();
        _requireNotHalted();
        Order storage order = _ownedActive(id);
        _requireNotFrozen(id, order);
        StockTokenRegistry.Asset memory a = registry.asset(order.asset);
        Units.requireOnTick(minPremium, a.priceTick);
        if (flip) _requireStrike(flipTarget, a.strikeTick);
        order.minPremium = minPremium;
        order.flip = flip;
        order.flipTarget = flip ? flipTarget : 0;
        emit OrderUpdated(id, minPremium, flip, order.flipTarget);
    }

    /// @notice Moves an order that isn't written into a series to a new target and size, with a
    /// new minimum premium and flip settings, and keeps its ID. Pass the current values to keep
    /// any of them.
    /// @dev The order faces every check a new order with these terms would, with its current size
    /// released first, so it fits the caps whenever cancelling and placing again would. It can't
    /// leave or enter a bucket a renewal batch holds, because a running batch counts and fills its
    /// bucket by order ID. Only the collateral difference moves: a shortfall is pulled now, and a
    /// surplus becomes claimable like every other payout.
    function amendOrder(uint256 id, AmendParams calldata p) external nonReentrant {
        liveness.checkpoint();
        _requireNotHalted();
        Order storage order = _ownedActive(id);
        if (order.series != 0) revert OrderAttached(id, order.series);
        _requireNotFrozen(id, order);
        _requireNotFrozenAt(id, order, p.target);
        StockTokenRegistry.Asset memory a = registry.asset(order.asset);
        Units.requireLots(p.size, a.lot);
        _requireStrike(p.target, a.strikeTick);
        Units.requireOnTick(p.minPremium, a.priceTick);
        if (p.flip) _requireStrike(p.flipTarget, a.strikeTick);

        // What the old terms hold, worked out before they're overwritten.
        (address token, uint256 released) = _collateralOf(order, order.size);
        idleSize[order.asset][order.side][order.target] -= order.size;
        _shrink(order, order.size);
        _checkPlacement(msg.sender, order.asset, order.side, p.size);
        order.target = p.target;
        order.minPremium = p.minPremium;
        order.flip = p.flip;
        order.flipTarget = p.flip ? p.flipTarget : 0;
        // The asset's current grid, exactly as a new order would take it.
        (order.rawUnit, order.lot) = (a.rawUnit, a.lot);
        _grow(order, p.size);
        idleSize[order.asset][order.side][p.target] += p.size;
        emit OrderAmended(id, p.target, p.minPremium, p.size, p.flip, order.flipTarget);
        (, uint256 required) = _collateralOf(order, p.size);
        if (required > released) _pull(token, msg.sender, required - released);
        else _credit(msg.sender, token, released - required);
    }

    /// @notice Stops the order. Uncommitted collateral becomes claimable now. A part written into
    /// this week's series stays there until the series settles.
    function cancelOrder(uint256 id) external nonReentrant {
        liveness.checkpoint();
        _requireNotHalted();
        Order storage order = _ownedActive(id);
        _requireNotFrozen(id, order);
        uint256 uncommitted = order.size - order.committed;
        (address token, uint256 amount) = _collateralOf(order, uncommitted);
        if (order.series == 0) idleSize[order.asset][order.side][order.target] -= uncommitted;
        _shrink(order, uncommitted);
        order.status = order.size == 0 ? OrderStatus.Closed : OrderStatus.Cancelled;
        emit OrderCancelled(id, amount);
        if (order.status == OrderStatus.Closed) emit OrderClosed(id);
        _credit(order.owner, token, amount);
    }

    /// @notice Settles the order's share of a settled series. Anyone may call it, so a keeper can
    /// renew orders without the owner.
    function settleOrder(uint256 id) external nonReentrant {
        liveness.checkpoint();
        _requireNotHalted();
        Order storage order = _orders[id];
        if (order.status == OrderStatus.None) revert UnknownOrder(id);
        uint256 series = order.series;
        if (series == 0) revert NothingToSettle(id);
        Pool storage pool = _pools[series];
        if (!pool.settled) revert SeriesNotSettled(series);

        uint256 shares = order.committed;
        uint256 back = Math.mulDiv(pool.collateral, shares, pool.remainingShares);
        uint256 proceeds = Math.mulDiv(pool.proceeds, shares, pool.remainingShares);
        pool.collateral -= back;
        pool.proceeds -= proceeds;
        pool.remainingShares -= shares;
        _shrink(order, shares);
        order.committed = 0;
        order.series = 0;
        attachedOrders[order.asset][order.side][order.target] -= 1;

        bool isCall = order.side == OptionType.Call;
        address collateralToken = isCall ? order.asset : usdg;
        address proceedsToken = isCall ? usdg : order.asset;
        uint256 renewed = 0;
        uint256 released = back;
        bool active = order.status == OrderStatus.Active;
        if (active) {
            uint256 lotCollateral =
                isCall ? order.lot : Units.valueExact(order.lot, order.target, order.rawUnit);
            // Only whole lots renew: floor to lots on purpose, the remainder is released below.
            // slither-disable-next-line divide-before-multiply
            uint256 lots = back / lotCollateral;
            renewed = lots * order.lot;
            released = back - lots * lotCollateral;
            _grow(order, renewed);
        }
        if (order.size == 0) {
            order.status = OrderStatus.Closed;
            emit OrderClosed(id);
        } else if (order.status == OrderStatus.Active) {
            idleSize[order.asset][order.side][order.target] += order.size;
        }
        emit OrderSettled(id, series, back, proceeds, renewed);
        // A cancelled order never flips: the holder stopped it.
        uint256 flipped = active && order.flip && proceeds != 0 ? _flip(id, order, proceeds) : 0;
        _credit(order.owner, proceedsToken, proceeds - flipped);
        _credit(order.owner, collateralToken, released);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        liveness.checkpoint();
        _requireNotHalted();
        uint256 available = claimable[msg.sender][token];
        if (amount > available) {
            revert InsufficientClaimable(msg.sender, token, amount, available);
        }
        claimable[msg.sender][token] = available - amount;
        emit Withdrawn(msg.sender, token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function orderOf(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    function poolOf(uint256 series) external view returns (Pool memory) {
        return _pools[series];
    }

    /// @dev Reverts when a new order would breach a pause or a launch cap. MarketGuard implements
    /// it.
    function _checkPlacement(address owner, address asset, OptionType side, uint256 size)
        internal
        view
        virtual;

    /// @dev The same test without reverting, for orders the market opens itself. MarketGuard
    /// implements it.
    function _placementAllowed(address owner, address asset, OptionType side, uint256 size)
        internal
        view
        virtual
        returns (bool);

    /// @dev Reverts while the order is part of a renewal batch that hasn't settled. RenewalBatch
    /// implements it.
    function _requireNotFrozen(uint256 id, Order storage order) internal view virtual;

    /// @dev Reverts when the order would be frozen at `target`, so an amend can't move an order
    /// into a bucket its renewal batch holds. RenewalBatch implements it.
    function _requireNotFrozenAt(uint256 id, Order storage order, uint256 target)
        internal
        view
        virtual;

    /// @dev Turns exercise proceeds into the opposite order at the flip target, in whole lots the
    /// proceeds fully collateralize, and returns how much of them it used. Returns 0 and opens
    /// nothing when the new order couldn't be placed: paused, halted, delisted or over a cap.
    function _flip(uint256 fromId, Order storage from, uint256 proceeds)
        private
        returns (uint256 used)
    {
        OptionType side = from.side == OptionType.Call ? OptionType.Put : OptionType.Call;
        uint256 perLot = side == OptionType.Call
            ? from.lot
            : Units.valueExact(from.lot, from.flipTarget, from.rawUnit);
        // Whole lots only: floor on purpose, the remainder is credited by the caller.
        // slither-disable-next-line divide-before-multiply
        uint256 lots = proceeds / perLot;
        uint256 size = lots * from.lot;
        if (size == 0 || !_placementAllowed(from.owner, from.asset, side, size)) return 0;
        used = lots * perLot;
        uint256 id = ++orderCount;
        Order storage to = _orders[id];
        (to.owner, to.asset, to.side, to.status) =
        (from.owner, from.asset, side, OrderStatus.Active);
        (to.target, to.minPremium, to.rawUnit, to.lot) =
        (from.flipTarget, from.minPremium, from.rawUnit, from.lot);
        _grow(to, size);
        idleSize[to.asset][side][to.target] += size;
        emit OrderPlaced(id, to.owner, to.asset, side, to.target, to.minPremium, size, false, 0);
        emit OrderFlipped(fromId, id);
    }

    function _written(uint256 series) internal view returns (uint256) {
        return _pools[series].written;
    }

    /// @dev Every change to an order's size goes through _grow and _shrink, which keep openSize and
    /// walletSize equal to the sums over active orders.
    function _grow(Order storage order, uint256 amount) private {
        order.size += amount;
        openSize[order.asset][order.side] += amount;
        walletSize[order.owner][order.asset][order.side] += amount;
    }

    function _shrink(Order storage order, uint256 amount) private {
        order.size -= amount;
        openSize[order.asset][order.side] -= amount;
        walletSize[order.owner][order.asset][order.side] -= amount;
    }

    /// @dev Writes `amount` of an order into `series`. Fill paths validate price and counterparty.
    function _commit(uint256 orderId, uint256 series, uint256 amount) internal {
        Order storage order = _orders[orderId];
        if (order.status != OrderStatus.Active) revert OrderNotActive(orderId);
        SeriesKey storage key = _key(series);
        if (key.asset != order.asset || key.optionType != order.side || key.strike != order.target)
        {
            revert SeriesMismatch(orderId, series);
        }
        if (block.timestamp >= key.expiry) revert SeriesClosed(series);
        if (order.series != 0 && order.series != series) revert SeriesMismatch(orderId, series);
        Units.requireLots(amount, order.lot);
        uint256 uncommitted = order.size - order.committed;
        if (amount > uncommitted) revert ExceedsUncommitted(orderId, amount, uncommitted);

        if (order.series == 0) {
            idleSize[order.asset][order.side][order.target] -= uncommitted;
            attachedOrders[order.asset][order.side][order.target] += 1;
        }
        order.series = series;
        order.committed += amount;
        Pool storage pool = _pools[series];
        pool.written += amount;
        (, uint256 collateral) = _collateralOf(order, amount);
        pool.collateral += collateral;
        emit OrderCommitted(orderId, series, amount);
    }

    /// @dev Exercises `amount` of `series` for `exerciser`, who holds the longs and pays in. The
    /// window check belongs to the caller.
    function _exercise(uint256 series, uint256 amount, address exerciser) internal {
        Pool storage pool = _pools[series];
        if (pool.settled) revert SeriesSettled(series);
        uint256 outstanding = pool.written - pool.exercised;
        if (amount > outstanding) revert ExceedsWritten(series, amount, outstanding);
        SeriesKey storage key = _key(series);
        // Units come from the epoch's snapshot. Settlement never reads the registry, so delisting
        // can't block an exercise.
        Epoch storage e = _epoch(key.asset, key.expiry);
        Units.requireLots(amount, e.lot);
        uint256 strikeValue = Units.valueExact(amount, key.strike, e.rawUnit);

        pool.exercised += amount;
        _burn(exerciser, series, amount);
        emit Exercised(series, exerciser, amount);
        if (key.optionType == OptionType.Call) {
            pool.collateral -= amount;
            pool.proceeds += strikeValue;
            _pull(usdg, exerciser, strikeValue);
            _credit(exerciser, key.asset, amount);
        } else {
            pool.collateral -= strikeValue;
            pool.proceeds += amount;
            _pull(key.asset, exerciser, amount);
            _credit(exerciser, usdg, strikeValue);
        }
    }

    /// @dev Closes the series to exercise. Remaining longs expire worthless.
    function _finalize(uint256 series) internal {
        Pool storage pool = _pools[series];
        if (pool.settled) revert SeriesSettled(series);
        pool.settled = true;
        pool.remainingShares = pool.written;
        emit SeriesFinalized(series, pool.written, pool.exercised);
    }

    function _credit(address owner, address token, uint256 amount) internal {
        if (amount == 0) return;
        claimable[owner][token] += amount;
        emit Credited(owner, token, amount);
    }

    function _pull(address token, address from, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        // `from` is the caller, or a maker whose signed quote covers this amount.
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedTransferAmount(token, amount, received);
    }

    function _orderStorage(uint256 id) internal view returns (Order storage o) {
        o = _orders[id];
        if (o.status == OrderStatus.None) revert UnknownOrder(id);
    }

    function _collateralOf(Order storage o, uint256 size)
        private
        view
        returns (address token, uint256 amount)
    {
        if (o.side == OptionType.Call) return (o.asset, size);
        return (usdg, Units.valueExact(size, o.target, o.rawUnit));
    }

    function _ownedActive(uint256 id) private view returns (Order storage o) {
        o = _orders[id];
        if (o.status == OrderStatus.None) revert UnknownOrder(id);
        if (o.owner != msg.sender) revert NotOrderOwner(id, msg.sender);
        if (o.status != OrderStatus.Active) revert OrderNotActive(id);
    }

    function _requireStrike(uint256 strike, uint256 strikeTick) private pure {
        if (strike == 0) revert Units.ZeroAmount();
        Units.requireOnTick(strike, strikeTick);
    }
}
