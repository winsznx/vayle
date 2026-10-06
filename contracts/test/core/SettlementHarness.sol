// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {SettlementEngine} from "../../src/core/SettlementEngine.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";

/// @dev Settlement without MarketGuard: no halts. Halts are tested with the guard in step 8.
contract SettlementHarness is SettlementEngine {
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

    function fill(uint256 orderId, uint256 series, uint256 amount, address buyer) external {
        _commit(orderId, series, amount);
        _mint(buyer, series, amount, "");
    }

    function _haltCount() internal pure override returns (uint256) {
        return 0;
    }

    function _haltAt(uint256) internal pure override returns (uint64, uint64) {
        return (0, 0);
    }

    function _requireNotHalted() internal pure override {}
}
