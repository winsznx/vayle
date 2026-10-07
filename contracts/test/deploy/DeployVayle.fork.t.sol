// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployVayle} from "../../script/DeployVayle.s.sol";
import {VayleMarket} from "../../src/VayleMarket.sol";
import {SessionCalendar} from "../../src/calendar/SessionCalendar.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {EpochBook} from "../../src/core/EpochBook.sol";
import {MarketGuard} from "../../src/core/MarketGuard.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {MarketFork} from "../utils/MarketFork.sol";
import {RunbookDeploy} from "./RunbookDeploy.sol";

/// @notice Rehearses the deploy script on a fork, back before the Sep 18 close so the fixed
/// boundaries are ahead and the real feed's rounds exist, then checks the end state and runs a week.
contract DeployVayleForkTest is MarketFork {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant PREMIUM = 2_500_000;
    uint256 internal constant DELAY = 8 days + 6 hours;

    DeployVayle internal script;
    DeployVayle.Deployment internal d;
    address internal multisig = makeAddr("multisig");
    address internal guardian = makeAddr("guardian");
    address internal teamMaker;
    uint256 internal teamMakerKey;

    function _config() internal view returns (DeployVayle.Config memory config) {
        SessionCalendar.Boundary[] memory boundaries = new SessionCalendar.Boundary[](5);
        boundaries[0] = SessionCalendar.Boundary(SEP_18, SEP_21_OPEN);
        boundaries[1] = SessionCalendar.Boundary(SEP_25, SEP_28_OPEN);
        boundaries[2] = SessionCalendar.Boundary(OCT_02, OCT_05_OPEN);
        boundaries[3] = SessionCalendar.Boundary(OCT_09, OCT_12_OPEN);
        boundaries[4] = SessionCalendar.Boundary(OCT_16, OCT_19_OPEN);
        DeployVayle.Market[] memory markets = new DeployVayle.Market[](1);
        markets[0] = DeployVayle.Market({
            token: stock,
            uid: stockUid,
            feed: stockFeed,
            lot: lot,
            priceTick: priceTick,
            strikeTick: strikeTick,
            strikeRangeBps: strikeRangeBps,
            sellCaps: MarketGuard.Caps({
                openSize: 10 * ONE,
                walletSize: 4 * ONE,
                seriesOpenInterest: 6 * ONE,
                fillSize: 2 * ONE
            }),
            buyCaps: MarketGuard.Caps({
                openSize: 4 * ONE,
                walletSize: 2 * ONE,
                seriesOpenInterest: 4 * ONE,
                fillSize: 2 * ONE
            })
        });
        config = DeployVayle.Config({
            multisig: multisig,
            guardian: guardian,
            teamMaker: teamMaker,
            boundaries: boundaries,
            markets: markets,
            usdg: usdg
        });
    }

    function setUp() public override {
        super.setUp();
        (teamMaker, teamMakerKey) = makeAddrAndKey("teamMaker");
        // The multisig is a contract on mainnet. Any code stands in for it here.
        vm.etch(multisig, hex"00");
        // Loaded from its artifact: embedding it would push this test past the code size limit.
        script = DeployVayle(vm.deployCode("DeployVayle.s.sol:DeployVayle"));
        d = script.deploy(_config(), address(script));
        // The fixture's helpers now drive the deployed contracts.
        (calendar, registry, adapter, liveness) = (d.calendar, d.registry, d.adapter, d.liveness);
    }

    function test_theTimelockEndsWithExactlyEightDaysSixHours() public view {
        // #then
        assertEq(d.timelock.getMinDelay(), 712_800);
        assertEq(script.TIMELOCK_DELAY(), DELAY);
    }

    function test_theMultisigHoldsEveryTimelockRole() public view {
        // #then
        assertTrue(d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), multisig));
        assertTrue(d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), multisig));
        assertTrue(d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), multisig));
    }

    function test_theDeployerEndsWithNoRole() public view {
        // #given
        bytes32[4] memory roles = [
            d.timelock.PROPOSER_ROLE(),
            d.timelock.CANCELLER_ROLE(),
            d.timelock.EXECUTOR_ROLE(),
            d.timelock.DEFAULT_ADMIN_ROLE()
        ];
        // #then
        for (uint256 i; i < roles.length; ++i) {
            assertFalse(d.timelock.hasRole(roles[i], address(script)));
        }
    }

    function test_theTimelockAdministersItself() public view {
        // #then
        assertTrue(d.timelock.hasRole(d.timelock.DEFAULT_ADMIN_ROLE(), address(d.timelock)));
    }

    function test_everyContractIsOwnedByTheTimelockAndConfigured() public view {
        // #then
        address owner = address(d.timelock);
        assertEq(d.market.owner(), owner);
        assertEq(d.registry.owner(), owner);
        assertEq(d.calendar.owner(), owner);
        assertEq(d.market.guardian(), guardian);
        assertEq(d.market.feeBps(), 0);
        assertEq(d.market.feeRecipient(), multisig);
        assertTrue(d.market.teamOperated(teamMaker));
        assertTrue(d.market.batchBidder(teamMaker));
        assertEq(d.market.capsOf(stock, OptionType.Call).openSize, 10 * ONE);
        assertEq(d.market.capsOf(stock, OptionType.Call).fillSize, 2 * ONE);
        assertEq(d.market.capsOf(stock, OptionType.Put).openSize, 4 * ONE);
        assertEq(d.market.capsOf(stock, OptionType.Put).walletSize, 2 * ONE);
        assertEq(d.registry.asset(stock).strikeTick, 5e6);
        assertEq(d.calendar.boundaryCount(), 5);
        assertEq(d.calendar.boundaryAt(0).close, SEP_18);
    }

    function test_theMultisigCantActBeforeTheDelay() public {
        // #given
        bytes memory call = abi.encodeCall(MarketGuard.setFee, (uint16(100), multisig));
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 0, DELAY)
        );
        // #when
        vm.prank(multisig);
        d.timelock.schedule(address(d.market), 0, call, bytes32(0), bytes32(0), 0);
    }

    function test_theMultisigActsAfterTheDelay() public {
        // #given
        bytes memory call = abi.encodeCall(MarketGuard.setFee, (uint16(100), multisig));
        vm.prank(multisig);
        d.timelock.schedule(address(d.market), 0, call, bytes32(0), bytes32(0), DELAY);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        // #when
        vm.prank(multisig);
        d.timelock.execute(address(d.market), 0, call, bytes32(0), bytes32(0));
        // #then
        assertEq(d.market.feeBps(), 100);
    }

    function test_aMultisigWithoutCodeIsRefused() public {
        // #given
        DeployVayle.Config memory config = _config();
        config.multisig = makeAddr("eoa");
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(DeployVayle.MultisigHasNoCode.selector, config.multisig)
        );
        // #when
        script.deploy(config, address(script));
    }

    function test_aConfigWithoutMarketsIsRefused() public {
        // #given
        DeployVayle.Config memory config = _config();
        config.markets = new DeployVayle.Market[](0);
        // #then
        vm.expectRevert(DeployVayle.NoMarkets.selector);
        // #when
        script.deploy(config, address(script));
    }

    function test_aDisabledSideReadsAsZeroCaps() public view {
        // #given
        string memory json = string.concat(
            '{"markets":[{"token":"',
            vm.toString(stock),
            '","uid":"',
            vm.toString(stockUid),
            '","feed":"',
            vm.toString(stockFeed),
            '","lot":"10000000000000000","priceTick":"100","strikeTick":"5000000",',
            '"strikeRangeBps":1000,',
            '"sell":{"enabled":true,"openSize":"10","walletSize":"4","seriesOpenInterest":"6",',
            '"fillSize":"2"},',
            '"buy":{"enabled":false,"openSize":"0","walletSize":"0","seriesOpenInterest":"0",',
            '"fillSize":"0"}}]}'
        );
        // #when
        DeployVayle.Market[] memory markets = script.readMarkets(json);
        // #then
        assertEq(markets.length, 1);
        assertEq(markets[0].sellCaps.seriesOpenInterest, 6);
        assertEq(markets[0].buyCaps.openSize, 0);
        assertEq(markets[0].buyCaps.fillSize, 0);
    }

    function test_theRunbookInputsParseIntoTheConfig() public {
        // #given: the env vars, and a boundaries file shaped like the one the runbook prepares
        RunbookDeploy runbook = RunbookDeploy(vm.deployCode("RunbookDeploy.sol:RunbookDeploy"));
        string memory path =
            string.concat(vm.projectRoot(), "/../deployments/runbook-test-boundaries.json");
        vm.writeFile(
            path,
            '[{"close":1791576000,"creationDeadline":1791811800},{"close":1792180800,"creationDeadline":1792416600}]'
        );
        vm.setEnv("MULTISIG", vm.toString(multisig));
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("TEAM_MAKER", vm.toString(teamMaker));
        // #when
        DeployVayle.Config memory config = runbook.readConfig();
        vm.removeFile(path);
        // #then: the markets are the committed registry file's
        assertEq(config.boundaries.length, 2);
        assertEq(config.boundaries[1].close, OCT_16);
        assertEq(config.boundaries[1].creationDeadline, OCT_19_OPEN);
        assertEq(config.multisig, multisig);
        assertEq(config.markets[0].token, stock);
        assertEq(config.markets[0].uid, stockUid);
        assertEq(config.markets[0].feed, stockFeed);
        assertEq(config.markets[0].strikeTick, strikeTick);
        assertEq(config.markets[0].sellCaps.openSize, 10 * ONE);
        assertEq(config.markets[0].buyCaps.openSize, 4 * ONE);
    }

    function test_theDeployedMarketOpensItsFirstWeekBeforeTheFirstClose() public {
        // #given: the keeper pings from deploy, and the first week opens the next afternoon
        uint64 opening = SEP_18 - 1 days;
        _keepAlive(vm.getBlockTimestamp() + 1 minutes, opening);
        (uint80 round, int256 answer,) = _lastRoundAtOrBefore(opening - 1);
        // #when
        uint64 expiry = d.market.createFirstEpoch(stock, round);
        // #then
        assertEq(expiry, SEP_18);
        assertEq(d.market.epoch(stock, expiry).opening, opening);
        assertEq(d.market.epoch(stock, expiry).referencePrice, _referencePriceFrom(answer));
    }

    function test_theDeployedMarketRunsAWholeWeek() public {
        // #given: the keeper opens the Oct 2 week, alice offers one NVDA, the team maker buys it
        VayleMarket market = d.market;
        (uint80 round, int256 answer,) = _lastRoundAtOrBefore(OCT_02);
        _runKeeper(EpochBook(market), OCT_02, OCT_02 - KEEPER_LEAD, OCT_02 + 10 minutes);
        market.createEpoch(stock, round);
        uint256 strike = (_referencePriceFrom(answer) / strikeTick + 1) * strikeTick;
        uint256 series = market.seriesFor(stock, OCT_09, OptionType.Call, strike);
        address alice = makeAddr("alice");
        vm.startPrank(ChainActors.FUNDING_SOURCE);
        IERC20(stock).transfer(alice, ONE);
        IERC20(usdg).transfer(teamMaker, 10_000e6);
        vm.stopPrank();
        vm.startPrank(alice);
        IERC20(stock).approve(address(market), ONE);
        uint256 id = market.placeOrder(
            CollateralVault.OrderParams({
                asset: stock,
                side: OptionType.Call,
                target: strike,
                minPremium: PREMIUM,
                size: ONE,
                flip: false,
                flipTarget: 0
            })
        );
        vm.stopPrank();
        vm.prank(teamMaker);
        IERC20(usdg).approve(address(market), type(uint256).max);
        QuoteSettlement.Quote memory q = QuoteSettlement.Quote({
            maker: teamMaker,
            taker: address(0),
            series: series,
            premium: PREMIUM,
            maxFeeBps: 0,
            maxAmount: ONE,
            minFill: lot,
            nonce: 1,
            deadline: OCT_09
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teamMakerKey, market.quoteDigest(q));
        market.fillQuote(q, abi.encodePacked(r, s, v), id, ONE);
        // #when: the maker exercises, the series settles, alice withdraws
        _keepAlive(OCT_09 - 5 minutes, OCT_09 + 30 minutes);
        vm.prank(teamMaker);
        market.exercise(series, ONE);
        _keepAlive(OCT_09 + 31 minutes, OCT_09 + 2 hours);
        market.finalize(series);
        market.settleOrder(id);
        uint256 proceeds = market.claimable(alice, usdg);
        vm.prank(alice);
        market.withdraw(usdg, proceeds);
        // #then: alice sold one NVDA at the strike and kept the premium
        assertEq(IERC20(usdg).balanceOf(alice), PREMIUM + strike);
        assertEq(market.claimable(teamMaker, stock), ONE);
    }
}
