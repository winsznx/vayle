// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
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
/// @dev run() broadcasts from DEPLOYER_KEY and, when it broadcasts, writes
/// deployments/vayle-robinhood-mainnet.json.
/// deploy() holds the logic, so a fork test can rehearse it without broadcasting. Every setting
/// only the timelock can change afterwards is final here: the markets and their caps come from
/// deployments/markets.json, the fee is zero with the multisig as recipient, and the delay is a
/// constant.
contract DeployVayle is Script {
    /// @notice A Stock Token to list, with its grid and both sides' caps. Sell targets are the
    /// call side and buy targets the put side. A disabled side gets zero caps.
    struct Market {
        address token;
        bytes32 uid;
        address feed;
        uint256 lot;
        uint256 priceTick;
        uint256 strikeTick;
        uint16 strikeRangeBps;
        MarketGuard.Caps sellCaps;
        MarketGuard.Caps buyCaps;
    }

    struct Config {
        address multisig;
        address guardian;
        address teamMaker;
        SessionCalendar.Boundary[] boundaries;
        Market[] markets;
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
    error NoBoundaries();
    error NoMarkets();
    error StrikeRangeTooWide(address token, uint256 strikeRangeBps);

    /// @dev Longer than the longest weekly epoch plus its exercise window. A Thursday 13:00 ET
    /// boundary before a Friday holiday runs to the next Friday's 16:00 ET close, 8 days 3 hours.
    uint256 public constant TIMELOCK_DELAY = 8 days + 6 hours;

    function run() external returns (Deployment memory d) {
        Config memory config = readConfig();
        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        d = deploy(config, vm.addr(key));
        vm.stopBroadcast();
        // A dry run deploys nothing, so it writes no addresses for the apps to pick up.
        if (
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
                || vm.isContext(VmSafe.ForgeContext.ScriptResume)
        ) {
            _record(d);
        }
    }

    function readConfig() public view returns (Config memory config) {
        string memory facts = vm.readFile(_path("robinhood-mainnet.json"));
        string memory boundaries = vm.readFile(_path(_boundariesFile()));
        config.multisig = vm.envAddress("MULTISIG");
        config.guardian = vm.envAddress("GUARDIAN");
        config.teamMaker = vm.envAddress("TEAM_MAKER");
        config.boundaries = abi.decode(vm.parseJson(boundaries), (SessionCalendar.Boundary[]));
        config.markets = readMarkets(vm.readFile(_path("markets.json")));
        config.usdg = vm.parseJsonAddress(facts, ".usdg.address");
    }

    /// @dev Reads `.markets[i]` until there's none. Sizes are decimal strings in the file.
    function readMarkets(string memory json) public view returns (Market[] memory markets) {
        uint256 count;
        while (vm.keyExistsJson(json, _entry(count))) ++count;
        markets = new Market[](count);
        for (uint256 i; i < count; ++i) {
            string memory entry = _entry(i);
            Market memory m = markets[i];
            m.token = vm.parseJsonAddress(json, string.concat(entry, ".token"));
            m.uid = vm.parseJsonBytes32(json, string.concat(entry, ".uid"));
            m.feed = vm.parseJsonAddress(json, string.concat(entry, ".feed"));
            m.lot = vm.parseJsonUint(json, string.concat(entry, ".lot"));
            m.priceTick = vm.parseJsonUint(json, string.concat(entry, ".priceTick"));
            m.strikeTick = vm.parseJsonUint(json, string.concat(entry, ".strikeTick"));
            uint256 range = vm.parseJsonUint(json, string.concat(entry, ".strikeRangeBps"));
            if (range > type(uint16).max) revert StrikeRangeTooWide(m.token, range);
            // forge-lint: disable-next-line(unsafe-typecast) checked against uint16's range above
            m.strikeRangeBps = uint16(range);
            m.sellCaps = _sideCaps(json, string.concat(entry, ".sell"));
            m.buyCaps = _sideCaps(json, string.concat(entry, ".buy"));
        }
    }

    function deploy(Config memory config, address deployer) public returns (Deployment memory d) {
        if (config.multisig.code.length == 0) revert MultisigHasNoCode(config.multisig);
        if (config.boundaries.length == 0) revert NoBoundaries();
        if (config.markets.length == 0) revert NoMarkets();

        address[] memory bootstrap = new address[](1);
        bootstrap[0] = deployer;
        d.timelock = new TimelockController(0, bootstrap, bootstrap, deployer);
        address owner = address(d.timelock);
        d.liveness = new LivenessCheckpoint();
        d.calendar = new SessionCalendar(owner, config.boundaries);
        d.registry = new StockTokenRegistry(owner, IERC20Metadata(config.usdg));
        d.adapter = new PriceAdapter(d.registry);
        d.market = new VayleMarket(
            d.calendar, d.registry, d.adapter, d.liveness, owner, config.guardian, config.multisig
        );

        _configure(d, config);
        _handOver(d.timelock, config.multisig, deployer);
    }

    /// @dev One batch through the timelock at zero delay: each market's listing and both sides'
    /// caps, the team maker's flags, and last the real delay, so the timelock is never usable at
    /// zero delay after this.
    function _configure(Deployment memory d, Config memory config) internal {
        uint256 count = config.markets.length * 3 + 3;
        address[] memory targets = new address[](count);
        bytes[] memory calls = new bytes[](count);
        uint256 n;
        for (uint256 i; i < config.markets.length; ++i) {
            Market memory m = config.markets[i];
            (targets[n], calls[n++]) =
            (
                address(d.registry),
                abi.encodeCall(
                    StockTokenRegistry.list,
                    (
                        m.token,
                        m.uid,
                        IPriceFeed(m.feed),
                        m.lot,
                        m.priceTick,
                        m.strikeTick,
                        m.strikeRangeBps
                    )
                )
            );
            (targets[n], calls[n++]) =
            (
                address(d.market),
                abi.encodeCall(MarketGuard.setCaps, (m.token, OptionType.Call, m.sellCaps))
            );
            (targets[n], calls[n++]) =
            (
                address(d.market),
                abi.encodeCall(MarketGuard.setCaps, (m.token, OptionType.Put, m.buyCaps))
            );
        }
        (targets[n], calls[n++]) =
        (address(d.market), abi.encodeCall(MarketGuard.setTeamOperated, (config.teamMaker, true)));
        (targets[n], calls[n++]) =
        (address(d.market), abi.encodeCall(MarketGuard.setBatchBidder, (config.teamMaker, true)));
        (targets[n], calls[n++]) =
        (address(d.timelock), abi.encodeCall(TimelockController.updateDelay, (TIMELOCK_DELAY)));
        uint256[] memory values = new uint256[](count);
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

    function _sideCaps(string memory json, string memory side)
        internal
        pure
        returns (MarketGuard.Caps memory caps)
    {
        if (!vm.parseJsonBool(json, string.concat(side, ".enabled"))) return caps;
        caps.openSize = vm.parseJsonUint(json, string.concat(side, ".openSize"));
        caps.walletSize = vm.parseJsonUint(json, string.concat(side, ".walletSize"));
        caps.seriesOpenInterest = vm.parseJsonUint(json, string.concat(side, ".seriesOpenInterest"));
        caps.fillSize = vm.parseJsonUint(json, string.concat(side, ".fillSize"));
    }

    function _entry(uint256 index) internal pure returns (string memory) {
        return string.concat(".markets[", vm.toString(index), "]");
    }

    /// @dev Under deployments/: the boundaries this deploy schedules, and where it writes the
    /// deployed addresses. DeployFork points both at deployments/fork/.
    function _boundariesFile() internal pure virtual returns (string memory) {
        return "calendar-boundaries.json";
    }

    function _recordFile() internal pure virtual returns (string memory) {
        return "vayle-robinhood-mainnet.json";
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
        vm.writeJson(json, _path(_recordFile()));
    }
}
