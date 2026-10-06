// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// @notice Every contract Vayle deploys fits the chain's code size limits, which the chain facts
/// script measured on chain and recorded.
contract DeployablesTest is Test {
    // Seven 32-byte constructor arguments, the most any deployable takes.
    uint256 internal constant CONSTRUCTOR_ARGS = 7 * 32;

    uint256 internal maxCodeSize;
    uint256 internal maxInitCodeSize;

    function setUp() public {
        string memory facts =
            vm.readFile(string.concat(vm.projectRoot(), "/../deployments/robinhood-mainnet.json"));
        maxCodeSize = vm.parseJsonUint(facts, ".chain.maxCodeSize");
        maxInitCodeSize = vm.parseJsonUint(facts, ".chain.maxInitCodeSize");
    }

    function _deployables() internal pure returns (string[5] memory) {
        return [
            "VayleMarket.sol:VayleMarket",
            "SessionCalendar.sol:SessionCalendar",
            "StockTokenRegistry.sol:StockTokenRegistry",
            "PriceAdapter.sol:PriceAdapter",
            "LivenessCheckpoint.sol:LivenessCheckpoint"
        ];
    }

    function test_everyDeployableRuntimeFitsTheChainsLimit() public view {
        // #given
        string[5] memory names = _deployables();
        for (uint256 i; i < names.length; ++i) {
            // #when
            uint256 size = vm.getDeployedCode(names[i]).length;
            // #then
            assertLe(size, maxCodeSize, names[i]);
        }
    }

    function test_everyDeployableInitCodeFitsTheChainsLimit() public view {
        // #given
        string[5] memory names = _deployables();
        for (uint256 i; i < names.length; ++i) {
            // #when
            uint256 size = vm.getCode(names[i]).length + CONSTRUCTOR_ARGS;
            // #then
            assertLe(size, maxInitCodeSize, names[i]);
        }
    }
}
