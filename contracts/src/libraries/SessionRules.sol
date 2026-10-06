// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title SessionRules
/// @notice Plausibility rules for a US equity session close timestamp.
/// @dev A regular close is 16:00 ET and an early close is 13:00 ET. In UTC that's 20:00 or 17:00
/// during daylight time and 21:00 or 18:00 during standard time. Holidays aren't encoded here.
/// The offchain calendar decides which days trade, and this only rejects timestamps that can't
/// be a close at all.
library SessionRules {
    uint256 internal constant DAY = 1 days;
    // 1970-01-01 was a Thursday. With Sunday as 0, Thursday is 4.
    uint256 private constant EPOCH_WEEKDAY = 4;

    /// @return Day of the week in UTC, 0 for Sunday through 6 for Saturday.
    function weekday(uint256 timestamp) internal pure returns (uint256) {
        return (timestamp / DAY + EPOCH_WEEKDAY) % 7;
    }

    function isSessionClose(uint256 timestamp) internal pure returns (bool) {
        uint256 day = weekday(timestamp);
        if (day == 0 || day == 6) return false;
        uint256 secondOfDay = timestamp % DAY;
        if (secondOfDay % 1 hours != 0) return false;
        uint256 hour = secondOfDay / 1 hours;
        return hour == 17 || hour == 18 || hour == 20 || hour == 21;
    }
}
