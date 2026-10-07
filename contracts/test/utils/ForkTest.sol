// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ChainActors} from "./ChainActors.sol";

interface IAccessControlled {
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

/// @notice Base for tests that run against Robinhood Chain mainnet state.
/// @dev The Stock Token under test is one market of deployments/markets.json, NVDA unless
/// FORK_MARKET names another symbol, so every suite can prove a market before it lists. USDG and
/// the chain ID come from deployments/robinhood-mainnet.json. Forks the latest block unless
/// FORK_BLOCK pins one. Without an RPC URL, on the wrong chain, or at a block before a dependency
/// existed, the suite fails with a named error instead of falling back to anything.
abstract contract ForkTest is Test {
    error MissingRpcUrl();
    error WrongChain(uint256 expected, uint256 actual);
    error MissingDependency(string name, address account);
    error UnknownMarket(string symbol);
    error UnsupportedDecimals(string symbol, uint256 decimals);

    string internal stockSymbol;
    address internal stock;
    bytes32 internal stockUid;
    uint256 internal stockDecimals;
    address internal stockFeed;
    address internal stockAccessRegistry;
    address internal usdg;
    uint256 internal usdgDecimals;
    /// @dev The market's entry in deployments/markets.json, for fixtures that read its grid.
    string internal marketsJson;
    string internal stockEntry;

    function setUp() public virtual {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) revert MissingRpcUrl();
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);

        string memory facts = vm.readFile(_deployments("robinhood-mainnet.json"));
        uint256 chainId = vm.parseJsonUint(facts, ".chain.chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        usdg = vm.parseJsonAddress(facts, ".usdg.address");
        usdgDecimals = vm.parseJsonUint(facts, ".usdg.decimals");

        stockSymbol = vm.envOr("FORK_MARKET", string("NVDA"));
        marketsJson = vm.readFile(_deployments("markets.json"));
        stockEntry = _entryOf(stockSymbol);
        stock = vm.parseJsonAddress(marketsJson, string.concat(stockEntry, ".token"));
        stockUid = vm.parseJsonBytes32(marketsJson, string.concat(stockEntry, ".uid"));
        stockDecimals = vm.parseJsonUint(marketsJson, string.concat(stockEntry, ".decimals"));
        stockFeed = vm.parseJsonAddress(marketsJson, string.concat(stockEntry, ".feed"));
        // Amounts in the suites are written in 18-decimal whole tokens.
        if (stockDecimals != 18) revert UnsupportedDecimals(stockSymbol, stockDecimals);
        _requireCode(stockSymbol, stock);
        _requireCode("usdg", usdg);
        _requireCode("feed", stockFeed);
        stockAccessRegistry = IAccessControlled(stock).ACCESS_CONTROLLED_REGISTRY();
        _requireCode("access registry", stockAccessRegistry);
    }

    /// @dev Moves real tokens from real holders, as transfers they could have made themselves.
    function _fundStock(address to, uint256 amount) internal {
        vm.prank(ChainActors.holderOf(stockSymbol));
        IERC20(stock).transfer(to, amount);
    }

    function _fundUsdg(address to, uint256 amount) internal {
        vm.prank(ChainActors.FUNDING_SOURCE);
        IERC20(usdg).transfer(to, amount);
    }

    function _entryOf(string memory symbol) private view returns (string memory entry) {
        for (uint256 i;; ++i) {
            entry = string.concat(".markets[", vm.toString(i), "]");
            if (!vm.keyExistsJson(marketsJson, entry)) revert UnknownMarket(symbol);
            string memory listed = vm.parseJsonString(marketsJson, string.concat(entry, ".symbol"));
            if (keccak256(bytes(listed)) == keccak256(bytes(symbol))) return entry;
        }
    }

    function _deployments(string memory file) private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", file);
    }

    function _requireCode(string memory name, address account) private view {
        if (account.code.length == 0) revert MissingDependency(name, account);
    }
}
