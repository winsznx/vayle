// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// @notice Base for tests that run against Robinhood Chain mainnet state.
/// @dev Addresses come from deployments/robinhood-mainnet.json, written by the chain facts script
/// from official sources. Forks the latest block unless FORK_BLOCK pins one. Without an RPC URL the
/// suite fails with MissingRpcUrl instead of falling back to anything.
abstract contract ForkTest is Test {
    error MissingRpcUrl();

    address internal nvda;
    bytes32 internal nvdaUid;
    address internal usdg;
    address internal nvdaFeed;
    address internal nvdaAccessRegistry;
    uint256 internal usdgDecimals;

    function setUp() public virtual {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) revert MissingRpcUrl();
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);

        string memory facts =
            vm.readFile(string.concat(vm.projectRoot(), "/../deployments/robinhood-mainnet.json"));
        nvda = vm.parseJsonAddress(facts, ".nvda.address");
        nvdaUid = vm.parseJsonBytes32(facts, ".nvda.uid");
        usdg = vm.parseJsonAddress(facts, ".usdg.address");
        nvdaFeed = vm.parseJsonAddress(facts, ".nvdaUsdFeed.proxy");
        nvdaAccessRegistry = vm.parseJsonAddress(facts, ".nvda.accessRegistry");
        usdgDecimals = vm.parseJsonUint(facts, ".usdg.decimals");
    }
}
