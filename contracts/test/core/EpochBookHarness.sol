// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";

/// @dev Exposes the internal series hooks of EpochBook for tests. The deployed core reaches them
/// only through its fill paths.
contract EpochBookHarness is EpochBook {
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

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function _requireNotHalted() internal pure override {}
}
