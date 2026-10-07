// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {SeriesKey} from "../../src/libraries/SeriesId.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice Campaign E at the interface: with the app, API and indexer off, a holder places an
/// order and later exits through calls built by the same code the fallback page and the app use.
/// Runs under FOUNDRY_PROFILE=interface, which allows FFI.
contract FallbackExitForkTest is VayleMarketFork {
    /// @dev The calldata the shared builders produce for `args`.
    function _built(string[] memory args) internal returns (bytes memory) {
        string[] memory command = new string[](args.length + 2);
        (command[0], command[1]) = ("node", "../packages/market/src/cli.ts");
        for (uint256 i; i < args.length; ++i) {
            command[i + 2] = args[i];
        }
        return vm.ffi(command);
    }

    function _send(address from, address to, string[] memory args) internal {
        bytes memory data = _built(args);
        vm.prank(from);
        (bool ok, bytes memory reason) = to.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function _args(string memory a) internal pure returns (string[] memory out) {
        out = new string[](1);
        out[0] = a;
    }

    function _args(string memory a, string memory b) internal pure returns (string[] memory out) {
        out = new string[](2);
        (out[0], out[1]) = (a, b);
    }

    function _args(string memory a, string memory b, string memory c)
        internal
        pure
        returns (string[] memory out)
    {
        out = new string[](3);
        (out[0], out[1], out[2]) = (a, b, c);
    }

    function _args(string memory a, string memory b, string memory c, string memory d)
        internal
        pure
        returns (string[] memory out)
    {
        out = new string[](4);
        (out[0], out[1], out[2], out[3]) = (a, b, c, d);
    }

    function test_theClientWorksOutTheSameSeriesIdsAsTheMarket() public {
        // #given
        uint256[2] memory series = [callSeries, putSeries];
        for (uint256 i; i < series.length; ++i) {
            SeriesKey memory key = market.seriesKey(series[i]);
            string[] memory args = new string[](8);
            (args[0], args[1], args[2], args[3]) =
            (
                "seriesId",
                vm.toString(key.chainId),
                vm.toString(key.asset),
                vm.toString(uint256(key.optionType))
            );
            (args[4], args[5], args[6], args[7]) =
            (
                vm.toString(key.strike),
                vm.toString(uint256(key.expiry)),
                vm.toString(uint256(key.windowLength)),
                vm.toString(key.collateralToken)
            );
            // #when
            uint256 computed = uint256(bytes32(_built(args)));
            // #then
            assertEq(computed, series[i]);
        }
    }

    function test_aHolderPlacesThenExitsThroughTheSharedBuilders() public {
        // #given: dave approves and places a sell order through the builders, and the maker buys it
        address dave = makeAddr("dave");
        vm.prank(ChainActors.FUNDING_SOURCE);
        IERC20(nvda).transfer(dave, ONE);
        _send(
            dave,
            nvda,
            _args("approve", vm.toString(nvda), vm.toString(address(market)), vm.toString(ONE))
        );
        string[] memory place = new string[](8);
        (place[0], place[1], place[2], place[3]) =
        ("placeOrder", vm.toString(nvda), "0", vm.toString(callStrike));
        (place[4], place[5], place[6], place[7]) =
        (vm.toString(PRICE_TICK * 10), vm.toString(ONE), "false", "0");
        _send(dave, address(market), place);
        uint256 id = market.orderCount();
        _fillQuote(id, callSeries, ONE);

        // #when: the maker exercises half through the builders, then dave finalizes, settles,
        // cancels and withdraws through them, with nothing else running
        _intoTheWindow();
        _send(
            quoter,
            address(market),
            _args("exercise", vm.toString(callSeries), vm.toString(ONE / 2))
        );
        _pastTheWindow();
        _send(dave, address(market), _args("finalize", vm.toString(callSeries)));
        _send(dave, address(market), _args("settleOrder", vm.toString(id)));
        _send(dave, address(market), _args("cancelOrder", vm.toString(id)));
        uint256 owedUsdg = market.claimable(dave, usdg);
        uint256 owedNvda = market.claimable(dave, nvda);
        _send(dave, address(market), _args("withdraw", vm.toString(usdg), vm.toString(owedUsdg)));
        _send(dave, address(market), _args("withdraw", vm.toString(nvda), vm.toString(owedNvda)));

        // #then: dave sold half at the strike, kept the premium, and got the other half back
        assertEq(IERC20(usdg).balanceOf(dave), PREMIUM + _value(ONE / 2, callStrike));
        assertEq(IERC20(nvda).balanceOf(dave), ONE / 2);
        assertEq(uint8(market.orderOf(id).status), uint8(CollateralVault.OrderStatus.Closed));
        _assertConserved(_claimants());
    }
}
