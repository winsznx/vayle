// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

enum OptionType {
    Call,
    Put
}

enum ExerciseStyle {
    European
}

enum SettlementType {
    Physical
}

/// @dev Earning collateral is reserved for a later version. Every series today is Idle.
enum CollateralMode {
    Idle
}

/// @notice Every term that makes two options different. The series ID commits to all of them.
/// @param strike USDG base units per one whole raw token.
/// @param expiry The session close the epoch expires at, in UTC seconds.
/// @param windowLength Length of the exercise window after expiry, in seconds.
/// @param unitBasis 1: amounts are raw token units, untouched by the token's UI multiplier.
/// @param collateralToken The asset for calls, USDG for puts.
struct SeriesKey {
    uint256 chainId;
    address asset;
    OptionType optionType;
    uint256 strike;
    uint64 expiry;
    uint32 windowLength;
    uint8 unitBasis;
    ExerciseStyle exerciseStyle;
    SettlementType settlementType;
    address collateralToken;
    CollateralMode collateralMode;
}

/// @title SeriesId
library SeriesId {
    uint8 internal constant RAW_UNITS = 1;

    function id(SeriesKey memory key) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(key)));
    }
}
