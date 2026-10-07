// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {VayleMarket} from "../src/VayleMarket.sol";
import {PriceAdapter} from "../src/assets/PriceAdapter.sol";
import {StockTokenRegistry} from "../src/assets/StockTokenRegistry.sol";
import {SessionCalendar} from "../src/calendar/SessionCalendar.sol";
import {MarketGuard} from "../src/core/MarketGuard.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";
import {OptionType} from "../src/libraries/SeriesId.sol";
import {LivenessCheckpoint} from "../src/liveness/LivenessCheckpoint.sol";

/// @notice Deploys Vayle owned by a timelock that starts at zero delay, configures it through that
/// timelock, raises the delay, hands every role to the multisig and drops the deployer's.
/// @dev run() broadcasts from DEPLOYER_KEY and writes deployments/vayle-robinhood-mainnet.json.
/// deploy() holds the logic, so a fork test can rehearse it without broadcasting.
contract DeployVayle is Script {
    // The order and strike grid: 0.01-token lots, 0.0001 USDG premium ticks, $5 strikes, strikes
    // within 10% of the reference price.
    uint256 internal constant LOT = 1e16;
    uint256 internal constant PRICE_TICK = 100;
    uint256 internal constant STRIKE_TICK = 5e6;
    uint16 internal constant STRIKE_RANGE_BPS = 1000;

    struct Config {
        address multisig;
        address guardian;
        address feeRecipient;
        address teamMaker;
        uint256 timelockDelay;
        MarketGuard.Caps callCaps;
        MarketGuard.Caps putCaps;
        SessionCalendar.Boundary[] boundaries;
        address nvda;
        bytes32 nvdaUid;
        address nvdaFeed;
        address usdg;
    }

    struct Deployment {
        TimelockController timelock;
        LivenessCheckpoint liveness;
        SessionCalendar calendar;
        StockTokenRegistry registry;
        PriceAdapter adapter;
        VayleMarket market;
    }

    error MultisigHasNoCode(address multisig);
    error DelayTooShort(uint256 delay, uint256 minimum);
    error NoBoundaries();

    /// @dev Longer than the longest weekly epoch plus its exercise window. A Thursday 13:00 ET
    /// boundary before a Friday holiday runs to the next Friday's 16:00 ET close, 8 days 3 hours.
    uint256 public constant MIN_TIMELOCK_DELAY = 8 days + 6 hours;

    function run() external returns (Deployment memory d) {
        Config memory config = readConfig();
        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        d = deploy(config, vm.addr(key));
        vm.stopBroadcast();
        _record(d);
    }

    function readConfig() public view returns (Config memory config) {
        string memory facts = vm.readFile(_path("robinhood-mainnet.json"));
        string memory boundaries = vm.readFile(_path("calendar-boundaries.json"));
        config.multisig = vm.envAddress("MULTISIG");
        config.guardian = vm.envAddress("GUARDIAN");
        config.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        config.teamMaker = vm.envAddress("TEAM_MAKER");
        config.timelockDelay = vm.envUint("TIMELOCK_DELAY");
        config.callCaps = _caps("CALL_CAPS");
        config.putCaps = _caps("PUT_CAPS");
        config.boundaries = abi.decode(vm.parseJson(boundaries), (SessionCalendar.Boundary[]));
        config.nvda = vm.parseJsonAddress(facts, ".nvda.address");
        config.nvdaUid = vm.parseJsonBytes32(facts, ".nvda.uid");
        config.nvdaFeed = vm.parseJsonAddress(facts, ".nvdaUsdFeed.proxy");
        config.usdg = vm.parseJsonAddress(facts, ".usdg.address");
    }

    function deploy(Config memory config, address deployer) public returns (Deployment memory d) {
        if (config.multisig.code.length == 0) revert MultisigHasNoCode(config.multisig);
        if (config.timelockDelay < MIN_TIMELOCK_DELAY) {
            revert DelayTooShort(config.timelockDelay, MIN_TIMELOCK_DELAY);
        }
        if (config.boundaries.length == 0) revert NoBoundaries();

        address[] memory bootstrap = new address[](1);
        bootstrap[0] = deployer;
        d.timelock = new TimelockController(0, bootstrap, bootstrap, deployer);
        address owner = address(d.timelock);
        d.liveness = new LivenessCheckpoint();
        d.calendar = new SessionCalendar(owner);
        d.registry = new StockTokenRegistry(owner, IERC20Metadata(config.usdg));
        d.adapter = new PriceAdapter(d.registry);
        d.market = new VayleMarket(
            d.calendar,
            d.registry,
            d.adapter,
            d.liveness,
            owner,
            config.guardian,
            config.feeRecipient
        );

        _configure(d, config);
        _handOver(d.timelock, config.multisig, deployer);
    }

    /// @dev One batch through the timelock at zero delay. The last call raises the delay, so the
    /// timelock is never usable at zero delay after this.
    function _configure(Deployment memory d, Config memory config) internal {
        address[] memory targets = new address[](6);
        bytes[] memory calls = new bytes[](6);
        (targets[0], calls[0]) =
        (
            address(d.registry),
            abi.encodeCall(
                StockTokenRegistry.list,
                (
                    config.nvda,
                    config.nvdaUid,
                    IPriceFeed(config.nvdaFeed),
                    LOT,
                    PRICE_TICK,
                    STRIKE_TICK,
                    STRIKE_RANGE_BPS
                )
            )
        );
        (targets[1], calls[1]) =
        (address(d.calendar), abi.encodeCall(SessionCalendar.append, (config.boundaries)));
        (targets[2], calls[2]) =
        (
            address(d.market),
            abi.encodeCall(MarketGuard.setCaps, (config.nvda, OptionType.Call, config.callCaps))
        );
        (targets[3], calls[3]) =
        (
            address(d.market),
            abi.encodeCall(MarketGuard.setCaps, (config.nvda, OptionType.Put, config.putCaps))
        );
        (targets[4], calls[4]) =
        (address(d.market), abi.encodeCall(MarketGuard.setTeamOperated, (config.teamMaker, true)));
        (targets[5], calls[5]) =
        (
            address(d.timelock),
            abi.encodeCall(TimelockController.updateDelay, (config.timelockDelay))
        );
        uint256[] memory values = new uint256[](6);
        d.timelock.scheduleBatch(targets, values, calls, bytes32(0), bytes32(0), 0);
        d.timelock.executeBatch(targets, values, calls, bytes32(0), bytes32(0));
    }

    function _handOver(TimelockController timelock, address multisig, address deployer) internal {
        bytes32[3] memory roles =
            [timelock.PROPOSER_ROLE(), timelock.CANCELLER_ROLE(), timelock.EXECUTOR_ROLE()];
        for (uint256 i; i < roles.length; ++i) {
            timelock.grantRole(roles[i], multisig);
            timelock.renounceRole(roles[i], deployer);
        }
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), deployer);
    }

    function _caps(string memory name) internal view returns (MarketGuard.Caps memory) {
        uint256[] memory values = vm.envUint(name, ",");
        return MarketGuard.Caps({
            openSize: values[0],
            walletSize: values[1],
            seriesOpenInterest: values[2],
            fillSize: values[3]
        });
    }

    function _path(string memory file) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", file);
    }

    function _record(Deployment memory d) internal {
        string memory key = "vayle";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "block", block.number);
        vm.serializeAddress(key, "timelock", address(d.timelock));
        vm.serializeAddress(key, "liveness", address(d.liveness));
        vm.serializeAddress(key, "calendar", address(d.calendar));
        vm.serializeAddress(key, "registry", address(d.registry));
        vm.serializeAddress(key, "priceAdapter", address(d.adapter));
        string memory json = vm.serializeAddress(key, "market", address(d.market));
        vm.writeJson(json, _path("vayle-robinhood-mainnet.json"));
    }
}
