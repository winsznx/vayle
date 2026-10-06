// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// @notice Base for tests that run against Robinhood Chain mainnet state.
/// @dev Addresses come from deployments/robinhood-mainnet.json, written by the chain facts script
/// from official sources. Forks the latest block unless FORK_BLOCK pins one. Without an RPC URL, on
/// the wrong chain, or at a block before a dependency existed, the suite fails with a named error
/// instead of falling back to anything.
abstract contract ForkTest is Test {
    error MissingRpcUrl();
    error WrongChain(uint256 expected, uint256 actual);
    error MissingDependency(string name, address account);

    address internal nvda;
    bytes32 internal nvdaUid;
    uint256 internal nvdaDecimals;
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
        uint256 chainId = vm.parseJsonUint(facts, ".chain.chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        nvda = vm.parseJsonAddress(facts, ".nvda.address");
        nvdaUid = vm.parseJsonBytes32(facts, ".nvda.uid");
        nvdaDecimals = vm.parseJsonUint(facts, ".nvda.decimals");
        usdg = vm.parseJsonAddress(facts, ".usdg.address");
        nvdaFeed = vm.parseJsonAddress(facts, ".nvdaUsdFeed.proxy");
        nvdaAccessRegistry = vm.parseJsonAddress(facts, ".nvda.accessRegistry");
        usdgDecimals = vm.parseJsonUint(facts, ".usdg.decimals");
        _requireCode("nvda", nvda);
        _requireCode("usdg", usdg);
        _requireCode("nvdaUsdFeed", nvdaFeed);
        _requireCode("nvdaAccessRegistry", nvdaAccessRegistry);
    }

    function _requireCode(string memory name, address account) private view {
        if (account.code.length == 0) revert MissingDependency(name, account);
    }
}
