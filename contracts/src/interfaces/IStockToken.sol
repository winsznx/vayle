// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice ERC-8056 core interface: raw balances never change on a corporate action, and the UI
/// multiplier converts raw amounts to shares (18-decimal fixed point).
interface IScaledUIAmount {
    function uiMultiplier() external view returns (uint256);
}

/// @notice ERC-8056 pending-multiplier interface.
interface IScaledUIAmountPending {
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}

/// @notice The parts of a Stock Token Vayle reads beyond ERC-20.
/// @dev uid() is the issuer's registry identity. Name and symbol can change at the same address,
/// so they're never used to identify a token. oraclePaused() is advisory and set while a corporate
/// action is processed.
interface IStockToken is IScaledUIAmount, IScaledUIAmountPending {
    function uid() external view returns (bytes32);
    function decimals() external view returns (uint8);
    function oraclePaused() external view returns (bool);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
