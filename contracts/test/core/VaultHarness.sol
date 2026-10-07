// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";

/// @dev Exposes the vault's internal hooks. In the deployed core, fills (step 7) commit and mint,
/// and settlement (step 6) exercises and finalizes inside the window rules.
contract VaultHarness is CollateralVault {
    constructor(
        SessionCalendar calendar_,
        StockTokenRegistry registry_,
        PriceAdapter priceAdapter_,
        LivenessCheckpoint liveness_
    ) EpochBook(calendar_, registry_, priceAdapter_, liveness_) {}

    function seriesFor(address asset, uint64 expiry, OptionType optionType, uint256 strike)
        external
        returns (uint256)
    {
        return _seriesFor(asset, expiry, optionType, strike);
    }

    /// @dev A fill: writes the order's collateral into the series and mints longs to the buyer.
    function fill(uint256 orderId, uint256 series, uint256 amount, address buyer) external {
        _commit(orderId, series, amount);
        _mint(buyer, series, amount, "");
    }

    function exercise(uint256 series, uint256 amount, address exerciser) external {
        _exercise(series, amount, exerciser);
    }

    function finalize(uint256 series) external {
        _finalize(series);
    }

    function _requireNotHalted() internal pure override {}

    function _checkPlacement(address, address, OptionType, uint256) internal pure override {}

    function _placementAllowed(address, address, OptionType, uint256)
        internal
        pure
        override
        returns (bool)
    {
        return true;
    }

    function _requireNotFrozen(uint256, Order storage) internal pure override {}
}
