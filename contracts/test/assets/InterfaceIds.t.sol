// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IScaledUIAmount, IScaledUIAmountPending} from "../../src/interfaces/IStockToken.sol";

contract InterfaceIdsTest is Test {
    function test_interfaceIdsMatchTheSpecRecordedInChainFacts() public view {
        // #given: IDs from the ERC-8056 text, recorded by the chain facts script
        string memory facts =
            vm.readFile(string.concat(vm.projectRoot(), "/../deployments/robinhood-mainnet.json"));
        bytes4 core = bytes4(vm.parseJsonBytes(facts, ".erc8056.interfaceIds.core"));
        bytes4 pending = bytes4(vm.parseJsonBytes(facts, ".erc8056.interfaceIds.pending"));
        // #then
        assertEq(type(IScaledUIAmount).interfaceId, core);
        assertEq(type(IScaledUIAmountPending).interfaceId, pending);
    }
}
