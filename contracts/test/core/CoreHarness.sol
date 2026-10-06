// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PriceAdapter} from "../../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../../src/liveness/LivenessCheckpoint.sol";

/// @dev The core up to quote settlement, without MarketGuard: no halts, pauses or caps. Those are
/// tested with the guard in step 8. Fee and team settings are exposed directly.
contract CoreHarness is QuoteSettlement {
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

    function setFee(uint16 feeBps_, address recipient) external {
        _setFee(feeBps_, recipient);
    }

    function setTeamOperated(address maker, bool flag) external {
        _setTeamOperated(maker, flag);
    }

    function _haltCount() internal pure override returns (uint256) {
        return 0;
    }

    function _haltAt(uint256) internal pure override returns (uint64, uint64) {
        return (0, 0);
    }

    function _requireNotHalted() internal pure override {}

    function _requireFillsOpen(address) internal pure override {}

    function _checkFillCaps(address, uint256, uint256) internal override {}
}
