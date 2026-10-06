// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {VaultHarness} from "../core/VaultHarness.sol";
import {ChainActors} from "./ChainActors.sol";
import {MarketFork} from "./MarketFork.sol";

interface ICoreHarness {
    function seriesFor(address asset, uint64 expiry, OptionType optionType, uint256 strike)
        external
        returns (uint256);
    function fill(uint256 orderId, uint256 series, uint256 amount, address buyer) external;
}

/// @notice The Oct 2 epoch (expiring Oct 9) with one call series and one put series at the first
/// listed strikes, and four wallets funded from a real holder. Each suite deploys its own core.
abstract contract CoreFork is MarketFork {
    uint256 internal constant RAW_UNIT = 1e18;

    CollateralVault internal core;
    uint256 internal referencePrice;
    uint256 internal callStrike;
    uint256 internal putStrike;
    uint256 internal callSeries;
    uint256 internal putSeries;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal maker = makeAddr("maker");

    function _deployCore() internal virtual returns (CollateralVault);

    function setUp() public virtual override {
        super.setUp();
        core = _deployCore();
        (uint80 round, int256 answer,) = _lastRoundAtOrBefore(OCT_02);
        _keepAlive(OCT_02 - 40 minutes, OCT_02 + 10 minutes);
        core.createEpoch(nvda, round);
        referencePrice = _referencePriceFrom(answer);
        callStrike = (referencePrice / STRIKE_TICK + 1) * STRIKE_TICK;
        putStrike = ((referencePrice - 1) / STRIKE_TICK) * STRIKE_TICK;
        callSeries =
            ICoreHarness(address(core)).seriesFor(nvda, OCT_09, OptionType.Call, callStrike);
        putSeries = ICoreHarness(address(core)).seriesFor(nvda, OCT_09, OptionType.Put, putStrike);
        address[4] memory wallets = [alice, bob, carol, maker];
        for (uint256 i; i < wallets.length; ++i) {
            _fund(wallets[i], 100e18, 1_000_000e6);
            vm.startPrank(wallets[i]);
            IERC20(nvda).approve(address(core), type(uint256).max);
            IERC20(usdg).approve(address(core), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _fund(address to, uint256 nvdaAmount, uint256 usdgAmount) internal {
        vm.startPrank(ChainActors.FUNDING_SOURCE);
        IERC20(nvda).transfer(to, nvdaAmount);
        IERC20(usdg).transfer(to, usdgAmount);
        vm.stopPrank();
    }

    function _params(OptionType side, uint256 target, uint256 size)
        internal
        view
        returns (CollateralVault.OrderParams memory)
    {
        return CollateralVault.OrderParams({
            asset: nvda,
            side: side,
            target: target,
            minPremium: PRICE_TICK * 10,
            size: size,
            flip: false,
            flipTarget: 0
        });
    }

    function _place(address owner, OptionType side, uint256 size) internal returns (uint256) {
        uint256 target = side == OptionType.Call ? callStrike : putStrike;
        vm.prank(owner);
        return core.placeOrder(_params(side, target, size));
    }

    function _value(uint256 amount, uint256 strike) internal pure returns (uint256) {
        return (amount * strike) / RAW_UNIT;
    }

    function _fill(uint256 orderId, uint256 series, uint256 amount) internal {
        ICoreHarness(address(core)).fill(orderId, series, amount, maker);
    }

    /// @dev Token conservation: what the core holds equals what it owes, per token.
    function _assertConserved(address[] memory owners) internal view {
        uint256 owedNvda;
        uint256 owedUsdg;
        for (uint256 id = 1; id <= core.orderCount(); ++id) {
            CollateralVault.Order memory o = core.orderOf(id);
            uint256 idle = o.size - o.committed;
            if (o.side == OptionType.Call) owedNvda += idle;
            else owedUsdg += Units.valueExact(idle, o.target, o.rawUnit);
        }
        CollateralVault.Pool memory c = core.poolOf(callSeries);
        CollateralVault.Pool memory p = core.poolOf(putSeries);
        owedNvda += c.collateral + p.proceeds;
        owedUsdg += p.collateral + c.proceeds;
        for (uint256 i; i < owners.length; ++i) {
            owedNvda += core.claimable(owners[i], nvda);
            owedUsdg += core.claimable(owners[i], usdg);
        }
        assertEq(IERC20(nvda).balanceOf(address(core)), owedNvda, "NVDA conservation");
        assertEq(IERC20(usdg).balanceOf(address(core)), owedUsdg, "USDG conservation");
    }

    function _everyone() internal view returns (address[] memory owners) {
        owners = new address[](4);
        (owners[0], owners[1], owners[2], owners[3]) = (alice, bob, carol, maker);
    }
}

/// @notice CoreFork with the vault harness, which exposes exercise and finalize without windows.
abstract contract VaultFork is CoreFork {
    VaultHarness internal vault;

    function _deployCore() internal override returns (CollateralVault) {
        vault = new VaultHarness(calendar, registry, adapter, liveness);
        return vault;
    }
}
