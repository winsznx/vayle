// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {StockTokenRegistry} from "../assets/StockTokenRegistry.sol";
import {ExternalReads} from "../libraries/ExternalReads.sol";
import {OptionType} from "../libraries/SeriesId.sol";
import {QuoteSettlement} from "./QuoteSettlement.sol";

/// @title MarketGuard
/// @notice Roles, pauses, the emergency halt and launch caps.
/// @dev The owner is the timelocked multisig. The guardian is a separate key that can only pause
/// new positions and halt. A pause never blocks exits. A halt blocks every user state change for
/// at most 72 hours, extends every exercise window by exactly the halted time, and the guardian
/// can't start another one until 72 hours after it ends. Only the owner can renew a halt. Caps are
/// in raw units of the underlying per asset and side, checked only when exposure grows.
abstract contract MarketGuard is QuoteSettlement, Ownable2Step {
    uint64 public constant HALT_DURATION = 72 hours;
    uint64 public constant GUARDIAN_HALT_COOLDOWN = 72 hours;

    enum Cap {
        OpenSize,
        WalletSize,
        SeriesOpenInterest,
        FillSize
    }

    /// @param openSize All orders on the side still holding collateral.
    /// @param walletSize The same, for one owner.
    /// @param seriesOpenInterest Written into one series.
    /// @param fillSize One fill.
    struct Caps {
        uint256 openSize;
        uint256 walletSize;
        uint256 seriesOpenInterest;
        uint256 fillSize;
    }

    address public guardian;
    bool public paused;
    mapping(address asset => bool) public assetPaused;
    mapping(address asset => mapping(OptionType side => Caps)) private _caps;
    Interval[] private _halts;

    event GuardianSet(address indexed guardian);
    event PausedSet(bool paused);
    event AssetPausedSet(address indexed asset, bool paused);
    event HaltStarted(uint64 start, uint64 end);
    event HaltExtended(uint64 start, uint64 end);
    event HaltEnded(uint64 start, uint64 end);
    event CapsSet(address indexed asset, OptionType indexed side, Caps caps);

    error NotGuardian(address caller);
    error ZeroGuardian();
    error RenounceDisabled();
    error MarketPaused(address asset);
    error MarketHalted(uint64 until);
    error OraclePaused(address asset);
    error AlreadyHalted(uint64 until);
    error HaltCoolingDown(uint64 availableAt);
    error NotHalted();
    error CapExceeded(Cap cap, uint256 wouldBe, uint256 limit);

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        _;
    }

    constructor(address owner_, address guardian_) Ownable(owner_) {
        _setGuardian(guardian_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        _setGuardian(guardian_);
    }

    function setFee(uint16 feeBps_, address recipient) external onlyOwner {
        _setFee(feeBps_, recipient);
    }

    function setTeamOperated(address maker, bool flag) external onlyOwner {
        _setTeamOperated(maker, flag);
    }

    function setCaps(address asset, OptionType side, Caps calldata caps) external onlyOwner {
        _caps[asset][side] = caps;
        emit CapsSet(asset, side, caps);
    }

    /// @notice Extends the active halt to 72 hours from now, or starts a new one. Owner only, so
    /// it runs through the timelock.
    function renewHalt() external onlyOwner {
        uint64 now_ = uint64(block.timestamp);
        uint64 end = now_ + HALT_DURATION;
        uint256 count = _halts.length;
        if (count != 0 && now_ < _halts[count - 1].end) {
            Interval storage active = _halts[count - 1];
            if (end > active.end) active.end = end;
            emit HaltExtended(active.start, active.end);
        } else {
            _halts.push(Interval({start: now_, end: end}));
            emit HaltStarted(now_, end);
        }
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function setPaused(bool flag) external onlyGuardian {
        paused = flag;
        emit PausedSet(flag);
    }

    function setAssetPaused(address asset, bool flag) external onlyGuardian {
        assetPaused[asset] = flag;
        emit AssetPausedSet(asset, flag);
    }

    function halt() external onlyGuardian {
        uint64 now_ = uint64(block.timestamp);
        uint256 count = _halts.length;
        if (count != 0) {
            uint64 lastEnd = _halts[count - 1].end;
            if (now_ < lastEnd) revert AlreadyHalted(lastEnd);
            uint64 availableAt = lastEnd + GUARDIAN_HALT_COOLDOWN;
            if (now_ < availableAt) revert HaltCoolingDown(availableAt);
        }
        uint64 end = now_ + HALT_DURATION;
        _halts.push(Interval({start: now_, end: end}));
        emit HaltStarted(now_, end);
    }

    /// @notice Lifts the active halt now.
    function endHalt() external onlyGuardian {
        uint256 count = _halts.length;
        if (count == 0 || block.timestamp >= _halts[count - 1].end) revert NotHalted();
        Interval storage active = _halts[count - 1];
        active.end = uint64(block.timestamp);
        emit HaltEnded(active.start, active.end);
    }

    function capsOf(address asset, OptionType side) external view returns (Caps memory) {
        return _caps[asset][side];
    }

    /// @notice When the active emergency halt ends, or 0 when none is active.
    function haltedUntil() external view returns (uint64) {
        uint256 count = _halts.length;
        if (count == 0) return 0;
        uint64 end = _halts[count - 1].end;
        return block.timestamp < end ? end : 0;
    }

    function haltCount() external view returns (uint256) {
        return _haltCount();
    }

    function haltAt(uint256 index) external view returns (uint64 start, uint64 end) {
        return _haltAt(index);
    }

    function _haltCount() internal view override returns (uint256) {
        return _halts.length;
    }

    /// @dev An active halt ends at now, so a window sweep never counts the future.
    function _haltAt(uint256 index) internal view override returns (uint64 start, uint64 end) {
        Interval storage h = _halts[index];
        uint64 now_ = uint64(block.timestamp);
        return (h.start, h.end < now_ ? h.end : now_);
    }

    function _requireNotHalted() internal view override {
        uint256 count = _halts.length;
        if (count == 0) return;
        uint64 end = _halts[count - 1].end;
        if (block.timestamp < end) revert MarketHalted(end);
    }

    /// @dev A delisted asset is settlement-only: its live series settle, but nothing new is written.
    function _requireFillsOpen(address asset) internal view override {
        _requireNotHalted();
        if (!registry.isListed(asset)) revert StockTokenRegistry.NotListed(asset);
        if (paused || assetPaused[asset]) revert MarketPaused(asset);
        if (ExternalReads.oraclePaused(asset)) revert OraclePaused(asset);
    }

    function _checkFillCaps(address asset, uint256 series, uint256 amount) internal view override {
        Caps storage caps = _caps[asset][_key(series).optionType];
        if (amount > caps.fillSize) revert CapExceeded(Cap.FillSize, amount, caps.fillSize);
        uint256 written = _written(series) + amount;
        if (written > caps.seriesOpenInterest) {
            revert CapExceeded(Cap.SeriesOpenInterest, written, caps.seriesOpenInterest);
        }
    }

    function _checkPlacement(address owner_, address asset, OptionType side, uint256 size)
        internal
        view
        override
    {
        _requireNotHalted();
        if (paused || assetPaused[asset]) revert MarketPaused(asset);
        Caps storage caps = _caps[asset][side];
        uint256 total = openSize[asset][side] + size;
        if (total > caps.openSize) revert CapExceeded(Cap.OpenSize, total, caps.openSize);
        uint256 wallet = walletSize[owner_][asset][side] + size;
        if (wallet > caps.walletSize) revert CapExceeded(Cap.WalletSize, wallet, caps.walletSize);
    }

    function _setGuardian(address guardian_) private {
        if (guardian_ == address(0)) revert ZeroGuardian();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }
}
