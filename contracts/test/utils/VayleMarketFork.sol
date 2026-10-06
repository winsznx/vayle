// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VayleMarket} from "../../src/VayleMarket.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {CoreFork} from "./VaultFork.sol";

/// @notice The deployable market on real NVDA and USDG with pilot-shaped caps, the Oct 2 epoch,
/// and a keyed maker that signs quotes. Market suites and the proof campaigns build on it.
abstract contract VayleMarketFork is CoreFork {
    uint256 internal constant ONE = 1e18;
    // 2.50 USDG per whole token.
    uint256 internal constant PREMIUM = 2_500_000;

    VayleMarket internal market;
    address internal timelock = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal quoter;
    uint256 internal quoterKey;
    uint256 internal nonce;

    function _pilotCaps() internal pure returns (MarketGuard.Caps memory) {
        return MarketGuard.Caps({
            openSize: 10 * ONE, walletSize: 4 * ONE, seriesOpenInterest: 6 * ONE, fillSize: 2 * ONE
        });
    }

    function _deployCore() internal override returns (CollateralVault) {
        market =
            new VayleMarket(calendar, registry, adapter, liveness, timelock, guardian, treasury);
        vm.startPrank(timelock);
        market.setCaps(nvda, OptionType.Call, _pilotCaps());
        market.setCaps(nvda, OptionType.Put, _pilotCaps());
        vm.stopPrank();
        return market;
    }

    function setUp() public virtual override {
        super.setUp();
        (quoter, quoterKey) = makeAddrAndKey("quoter");
        _fund(quoter, 10 * ONE, 100_000e6);
        vm.startPrank(quoter);
        IERC20(usdg).approve(address(market), type(uint256).max);
        IERC20(nvda).approve(address(market), type(uint256).max);
        vm.stopPrank();
    }

    function _signedQuote(uint256 series, uint256 amount)
        internal
        returns (QuoteSettlement.Quote memory q, bytes memory sig)
    {
        return _signedQuoteAt(series, amount, PREMIUM);
    }

    function _signedQuoteAt(uint256 series, uint256 amount, uint256 premium)
        internal
        returns (QuoteSettlement.Quote memory q, bytes memory sig)
    {
        q = QuoteSettlement.Quote({
            maker: quoter,
            taker: address(0),
            series: series,
            premium: premium,
            maxFeeBps: market.feeBps(),
            maxAmount: amount,
            minFill: LOT,
            nonce: ++nonce,
            deadline: OCT_09
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoterKey, market.quoteDigest(q));
        sig = abi.encodePacked(r, s, v);
    }

    function _fillQuote(uint256 orderId, uint256 series, uint256 amount) internal {
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(series, amount);
        market.fillQuote(q, sig, orderId, amount);
    }

    function _writeCall(address owner, uint256 size) internal returns (uint256 id) {
        id = _place(owner, OptionType.Call, size);
        _fillQuote(id, callSeries, size);
    }

    function _claimants() internal view returns (address[] memory owners) {
        owners = new address[](6);
        (owners[0], owners[1], owners[2], owners[3], owners[4], owners[5]) =
        (alice, bob, carol, maker, quoter, treasury);
    }

    /// @dev Liveness pings into the exercise window, then on to its end, so no gap extends it.
    function _intoTheWindow() internal {
        _keepAlive(OCT_09 - 5 minutes, OCT_09 + 30 minutes);
    }

    function _pastTheWindow() internal {
        _keepAlive(OCT_09 + 31 minutes, OCT_09 + 2 hours);
    }

    function _throughTheWindow() internal {
        _intoTheWindow();
        _pastTheWindow();
    }
}
