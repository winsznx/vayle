// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";
import {ExternalReads} from "../../src/libraries/ExternalReads.sol";
import {ForkTest} from "../utils/ForkTest.sol";

contract StockTokenRegistryForkTest is ForkTest {
    uint256 internal constant LOT = 1e16;
    uint256 internal constant PRICE_TICK = 100;
    uint256 internal constant STRIKE_TICK = 5e6;
    uint16 internal constant STRIKE_RANGE_BPS = 1000;

    address internal admin = makeAddr("admin");
    StockTokenRegistry internal registry;

    event AssetListed(
        address indexed token,
        bytes32 uid,
        address feed,
        uint256 lot,
        uint256 priceTick,
        uint256 strikeTick,
        uint16 strikeRangeBps
    );

    function setUp() public override {
        super.setUp();
        registry = new StockTokenRegistry(admin, IERC20Metadata(usdg));
    }

    function _list(address token, bytes32 uid, uint256 priceTick, uint256 strikeTick, uint16 range)
        internal
    {
        vm.prank(admin);
        registry.list(token, uid, IPriceFeed(nvdaFeed), LOT, priceTick, strikeTick, range);
    }

    function test_readsUsdgDecimalsFromTheChain() public view {
        // #then
        assertEq(registry.usdgDecimals(), usdgDecimals);
    }

    function test_listsTheRealNvdaToken() public {
        // #then
        vm.expectEmit(address(registry));
        emit AssetListed(nvda, nvdaUid, nvdaFeed, LOT, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
        // #when
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
        // #then
        StockTokenRegistry.Asset memory listed = registry.asset(nvda);
        assertEq(listed.uid, nvdaUid);
        assertEq(listed.decimals, nvdaDecimals);
        assertEq(listed.rawUnit, 10 ** nvdaDecimals);
        assertEq(listed.feedDecimals, IPriceFeed(nvdaFeed).decimals());
        assertTrue(listed.listed);
    }

    function test_refusesAUidThatDoesntMatchTheToken() public {
        // #given
        bytes32 wrong = keccak256("not the uid");
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(StockTokenRegistry.UidMismatch.selector, nvda, wrong, nvdaUid)
        );
        // #when
        _list(nvda, wrong, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
    }

    function test_refusesAContractThatIsntAStockToken() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(ExternalReads.NotAStockToken.selector, usdg));
        // #when
        _list(usdg, nvdaUid, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
    }

    function test_refusesAFeedThatIsntAPriceFeed() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(ExternalReads.FeedUnusable.selector, usdg));
        // #when
        vm.prank(admin);
        registry.list(
            nvda, nvdaUid, IPriceFeed(usdg), LOT, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS
        );
    }

    function test_refusesAnAddressWithoutCode() public {
        // #given
        address empty = makeAddr("empty");
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotAContract.selector, empty));
        // #when
        _list(empty, nvdaUid, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
    }

    function test_refusesAGridThatCantDivideExactly() public {
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                StockTokenRegistry.InexactGrid.selector, LOT, 1, 10 ** nvdaDecimals
            )
        );
        // #when
        _list(nvda, nvdaUid, 1, STRIKE_TICK, STRIKE_RANGE_BPS);
    }

    function test_refusesAStrikeTickOffThePriceTick() public {
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                StockTokenRegistry.BadStrikeGrid.selector,
                STRIKE_TICK + 1,
                PRICE_TICK,
                STRIKE_RANGE_BPS
            )
        );
        // #when
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK + 1, STRIKE_RANGE_BPS);
    }

    function test_refusesAStrikeRangeOfZeroOrTheWholePrice() public {
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                StockTokenRegistry.BadStrikeGrid.selector, STRIKE_TICK, PRICE_TICK, uint16(0)
            )
        );
        // #when
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK, 0);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                StockTokenRegistry.BadStrikeGrid.selector, STRIKE_TICK, PRICE_TICK, uint16(10_000)
            )
        );
        // #when
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK, 10_000);
    }

    function test_refusesListingTwice() public {
        // #given
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.AlreadyListed.selector, nvda));
        // #when
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
    }

    function test_delistingStopsLookupsAndAllowsRelisting() public {
        // #given
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
        // #when
        vm.prank(admin);
        registry.delist(nvda);
        // #then
        assertFalse(registry.isListed(nvda));
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, nvda));
        registry.asset(nvda);
        _list(nvda, nvdaUid, PRICE_TICK, STRIKE_TICK, STRIKE_RANGE_BPS);
        assertTrue(registry.isListed(nvda));
    }

    function test_listingAndDelistingAreOwnerOnly() public {
        // #given
        address stranger = makeAddr("stranger");
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        // #when
        vm.prank(stranger);
        registry.list(nvda, nvdaUid, IPriceFeed(nvdaFeed), LOT, PRICE_TICK, STRIKE_TICK, 1000);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        // #when
        vm.prank(stranger);
        registry.delist(nvda);
    }
}
