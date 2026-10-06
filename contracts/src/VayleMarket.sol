// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PriceAdapter} from "./assets/PriceAdapter.sol";
import {StockTokenRegistry} from "./assets/StockTokenRegistry.sol";
import {SessionCalendar} from "./calendar/SessionCalendar.sol";
import {EpochBook} from "./core/EpochBook.sol";
import {MarketGuard} from "./core/MarketGuard.sol";
import {OptionType} from "./libraries/SeriesId.sol";
import {LivenessCheckpoint} from "./liveness/LivenessCheckpoint.sol";

/// @title VayleMarket
/// @notice Physically settled, fully collateralized weekly options on Stock Tokens, written by
/// holders' standing orders and bought by makers' signed quotes.
/// @dev The deployable core. It isn't upgradeable: a new version is a new deployment. Every module
/// it's built from is documented where it's defined.
contract VayleMarket is MarketGuard {
    constructor(
        SessionCalendar calendar_,
        StockTokenRegistry registry_,
        PriceAdapter priceAdapter_,
        LivenessCheckpoint liveness_,
        address owner_,
        address guardian_,
        address feeRecipient_
    ) EpochBook(calendar_, registry_, priceAdapter_, liveness_) MarketGuard(owner_, guardian_) {
        _setFee(0, feeRecipient_);
    }

    /// @notice The ID of a series at a listed strike, registering it on first use. Anyone may call
    /// it, for example a maker before quoting.
    function seriesFor(address asset, uint64 expiry, OptionType optionType, uint256 strike)
        external
        nonReentrant
        returns (uint256)
    {
        return _seriesFor(asset, expiry, optionType, strike);
    }
}
