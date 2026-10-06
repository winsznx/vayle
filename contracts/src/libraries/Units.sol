// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Units
/// @notice Raw-unit arithmetic for options on Stock Tokens.
/// @dev Amounts are token base units. Prices (strikes and premiums) are USDG base units per one
/// whole raw token, which is `rawUnit = 10**decimals` base units. A corporate action that only
/// changes a token's UI multiplier leaves raw balances, and so every obligation, untouched.
/// When amounts are whole lots and prices sit on the price tick, `lot * priceTick % rawUnit == 0`
/// makes every value an exact integer.
library Units {
    uint256 internal constant BPS = 10_000;

    error ZeroAmount();
    error NotALot(uint256 amount, uint256 lot);
    error NotOnTick(uint256 price, uint256 tick);
    error InexactValue(uint256 amount, uint256 price, uint256 rawUnit);

    /// @notice USDG base units owed for `amount` at `price`, rounded as the caller specifies.
    function value(uint256 amount, uint256 price, uint256 rawUnit, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(amount, price, rawUnit, rounding);
    }

    /// @notice USDG base units owed for `amount` at `price`, reverting unless the value is exact.
    /// @dev Settlement paths use this, so a value can never be silently rounded in anyone's favor.
    function valueExact(uint256 amount, uint256 price, uint256 rawUnit)
        internal
        pure
        returns (uint256 result)
    {
        result = Math.mulDiv(amount, price, rawUnit);
        if (mulmod(amount, price, rawUnit) != 0) revert InexactValue(amount, price, rawUnit);
    }

    /// @notice Protocol fee on a premium, rounded up because the payer covers it.
    function fee(uint256 premium, uint256 feeBps) internal pure returns (uint256) {
        return Math.mulDiv(premium, feeBps, BPS, Math.Rounding.Ceil);
    }

    function requireLots(uint256 amount, uint256 lot) internal pure {
        if (amount == 0) revert ZeroAmount();
        if (amount % lot != 0) revert NotALot(amount, lot);
    }

    function requireOnTick(uint256 price, uint256 tick) internal pure {
        if (price % tick != 0) revert NotOnTick(price, tick);
    }

    /// @notice True when whole lots at on-tick prices always give exact values.
    function gridIsExact(uint256 lot, uint256 priceTick, uint256 rawUnit)
        internal
        pure
        returns (bool)
    {
        return lot != 0 && priceTick != 0 && mulmod(lot, priceTick, rawUnit) == 0;
    }
}
