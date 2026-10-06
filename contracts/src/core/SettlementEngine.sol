// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SeriesKey} from "../libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../liveness/LivenessCheckpoint.sol";
import {CollateralVault} from "./CollateralVault.sol";

/// @title SettlementEngine
/// @notice European exercise in a window after each expiry, physical delivery, and finalization.
/// @dev No oracle is read here. The window opens at expiry and closes once its length of usable
/// time has passed. Time nobody could act doesn't count: liveness gaps (up to a 24-hour budget),
/// issuer pauses of the asset or USDG, and emergency halts. The end is recomputed on every call
/// until finalize() closes the series.
abstract contract SettlementEngine is CollateralVault {
    uint64 public constant LIVENESS_EXTENSION_CAP = 24 hours;
    uint256 private constant MAX_SWEEP_STEPS = 512;

    uint8 private constant NONE = 0;
    uint8 private constant GAP = 1;
    uint8 private constant PAUSE = 2;
    uint8 private constant HALT = 3;

    struct Interval {
        uint64 start;
        uint64 end;
    }

    struct PauseLog {
        Interval[] closed;
        uint64 openSince;
    }

    mapping(address asset => PauseLog) private _pauses;

    event PauseObserved(address indexed asset, uint64 start);
    event PauseEnded(address indexed asset, uint64 start, uint64 end);

    error WindowNotOpen(uint256 series, uint64 opensAt);
    error WindowClosed(uint256 series, uint64 closedAt);
    error WindowStillOpen(uint256 series, uint64 endsAt);

    /// @notice Exercises `amount` of the caller's longs. A call pays the strike in USDG and is
    /// credited the asset. A put delivers the asset and is credited the strike in USDG.
    function exercise(uint256 series, uint256 amount) external nonReentrant {
        liveness.checkpoint();
        SeriesKey storage key = _key(series);
        _observePauses(key.asset);
        if (block.timestamp < key.expiry) revert WindowNotOpen(series, key.expiry);
        uint64 end = _windowEnd(key);
        if (block.timestamp >= end) revert WindowClosed(series, end);
        _requireNotHalted();
        _exercise(series, amount, msg.sender);
    }

    /// @notice Closes the series once its window has ended. Anyone may call it.
    function finalize(uint256 series) external nonReentrant {
        liveness.checkpoint();
        _requireNotHalted();
        SeriesKey storage key = _key(series);
        _observePauses(key.asset);
        uint64 end = _windowEnd(key);
        if (block.timestamp < end) revert WindowStillOpen(series, end);
        _finalize(series);
    }

    /// @notice Records whether the asset or USDG is paused by its issuer. The keeper calls it every
    /// minute during windows, and anyone may call it.
    function observePauses(address asset) external nonReentrant {
        _observePauses(asset);
    }

    function windowEnd(uint256 series) external view returns (uint64) {
        return _windowEnd(_key(series));
    }

    function pauseCount(address asset) external view returns (uint256) {
        return _pauseCount(asset);
    }

    function pauseAt(address asset, uint256 index) external view returns (uint64, uint64) {
        return _pauseAt(asset, index);
    }

    /// @dev Emergency halts in time order. While a halt is active the last one ends at now.
    /// MarketGuard implements these.
    function _haltCount() internal view virtual returns (uint256);
    function _haltAt(uint256 index) internal view virtual returns (uint64 start, uint64 end);

    /// @dev Cursor state for the window sweep, one cursor per source of dead time.
    struct Sweep {
        address asset;
        uint64 t;
        uint64 remaining;
        uint64 gapBudget;
        uint256 gi;
        uint256 gn;
        uint256 pi;
        uint256 pn;
        uint256 hi;
        uint256 hn;
    }

    /// @dev Walks dead intervals in time order and spends the window's length on live time only.
    /// Overlapping intervals from different sources count once. Gap time beyond the 24-hour budget
    /// counts as live.
    function _windowEnd(SeriesKey storage key) internal view returns (uint64) {
        Sweep memory w = Sweep({
            asset: key.asset,
            t: key.expiry,
            remaining: key.windowLength,
            gapBudget: LIVENESS_EXTENSION_CAP,
            gi: liveness.firstGapEndingAfter(key.expiry),
            gn: liveness.gapCount(),
            pi: _firstPauseEndingAfter(key.asset, key.expiry),
            pn: _pauseCount(key.asset),
            hi: _firstHaltEndingAfter(key.expiry),
            hn: _haltCount()
        });
        for (uint256 step; step < MAX_SWEEP_STEPS; ++step) {
            (uint64 start, uint64 end, uint8 kind) = _nextDead(w);
            if (kind == NONE || start >= w.t + w.remaining) break;
            if (start > w.t) {
                w.remaining -= start - w.t;
                w.t = start;
            }
            if (end > w.t) {
                uint64 dead = end - w.t;
                if (kind == GAP) {
                    if (dead > w.gapBudget) dead = w.gapBudget;
                    w.gapBudget -= dead;
                }
                w.t += dead;
            }
            if (kind == GAP) ++w.gi;
            else if (kind == PAUSE) ++w.pi;
            else ++w.hi;
        }
        return w.t + w.remaining;
    }

    /// @dev The earliest-starting interval among the sources' next ones. Ties go to the gap.
    function _nextDead(Sweep memory w) private view returns (uint64 start, uint64 end, uint8 kind) {
        start = type(uint64).max;
        if (w.gapBudget != 0 && w.gi < w.gn) {
            LivenessCheckpoint.Gap memory gap = liveness.gapAt(w.gi);
            (start, end, kind) = (gap.start, gap.end, GAP);
        }
        if (w.pi < w.pn) {
            (uint64 s, uint64 e) = _pauseAt(w.asset, w.pi);
            if (s < start) (start, end, kind) = (s, e, PAUSE);
        }
        if (w.hi < w.hn) {
            (uint64 s, uint64 e) = _haltAt(w.hi);
            if (s < start) (start, end, kind) = (s, e, HALT);
        }
    }

    function _observePauses(address asset) internal {
        PauseLog storage log = _pauses[asset];
        bool paused = _isPaused(asset);
        uint64 now_ = uint64(block.timestamp);
        if (paused && log.openSince == 0) {
            log.openSince = now_;
            emit PauseObserved(asset, now_);
        } else if (!paused && log.openSince != 0) {
            uint64 start = log.openSince;
            log.closed.push(Interval({start: start, end: now_}));
            log.openSince = 0;
            emit PauseEnded(asset, start, now_);
        }
    }

    /// @dev Closed pauses, then the open one, if any, ending now.
    function _pauseCount(address asset) private view returns (uint256) {
        PauseLog storage log = _pauses[asset];
        return log.closed.length + (log.openSince != 0 ? 1 : 0);
    }

    function _pauseAt(address asset, uint256 index) private view returns (uint64, uint64) {
        PauseLog storage log = _pauses[asset];
        if (index < log.closed.length) return (log.closed[index].start, log.closed[index].end);
        return (log.openSince, uint64(block.timestamp));
    }

    function _firstPauseEndingAfter(address asset, uint64 t) private view returns (uint256 index) {
        Interval[] storage closed = _pauses[asset].closed;
        uint256 hi = closed.length;
        while (index < hi) {
            uint256 mid = (index + hi) / 2;
            if (closed[mid].end <= t) index = mid + 1;
            else hi = mid;
        }
    }

    function _firstHaltEndingAfter(uint64 t) private view returns (uint256 index) {
        uint256 hi = _haltCount();
        while (index < hi) {
            uint256 mid = (index + hi) / 2;
            (, uint64 end) = _haltAt(mid);
            if (end <= t) index = mid + 1;
            else hi = mid;
        }
    }

    /// @dev The asset, its access registry and USDG are probed with staticcalls. A probe that
    /// fails or returns something other than true counts as not paused, so a token upgrade that
    /// drops a flag can't brick settlement.
    function _isPaused(address asset) private view returns (bool) {
        if (_flag(asset, "paused()") || _flag(asset, "tokenPaused()")) return true;
        (bool ok, bytes memory data) =
            asset.staticcall(abi.encodeWithSignature("ACCESS_CONTROLLED_REGISTRY()"));
        if (ok && data.length == 32) {
            uint256 word = abi.decode(data, (uint256));
            if (word <= type(uint160).max) {
                // forge-lint: disable-next-line(unsafe-typecast) the range check above makes it exact
                address accessRegistry = address(uint160(word));
                if (accessRegistry.code.length != 0 && _flag(accessRegistry, "paused()")) {
                    return true;
                }
            }
        }
        return _flag(usdg, "paused()");
    }

    function _flag(address target, string memory signature) private view returns (bool) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(signature));
        return ok && data.length == 32 && abi.decode(data, (uint256)) == 1;
    }
}
