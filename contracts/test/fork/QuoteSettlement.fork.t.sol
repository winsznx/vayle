// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {CoreHarness} from "../core/CoreHarness.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {MakerWallet} from "../utils/MakerWallet.sol";
import {CoreFork} from "../utils/VaultFork.sol";

contract QuoteSettlementForkTest is CoreFork {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant QUOTER_USDG = 100_000e6;
    // 2.50 USDG per whole token.
    uint256 internal constant PREMIUM = 2_500_000;

    CoreHarness internal market;
    address internal quoter;
    uint256 internal quoterKey;
    address internal treasury = makeAddr("treasury");

    function _deployCore() internal override returns (CollateralVault) {
        market = new CoreHarness(calendar, registry, adapter, liveness);
        return market;
    }

    function setUp() public override {
        super.setUp();
        (quoter, quoterKey) = makeAddrAndKey("quoter");
        _fundUsdg(quoter);
        vm.prank(quoter);
        IERC20(usdg).approve(address(market), type(uint256).max);
        market.setFee(0, treasury);
    }

    function _fundUsdg(address to) internal {
        vm.prank(ChainActors.FUNDING_SOURCE);
        IERC20(usdg).transfer(to, QUOTER_USDG);
    }

    function _quote(uint256 series, uint256 maxAmount)
        internal
        view
        returns (QuoteSettlement.Quote memory)
    {
        return QuoteSettlement.Quote({
            maker: quoter,
            taker: address(0),
            series: series,
            premium: PREMIUM,
            maxFeeBps: 0,
            maxAmount: maxAmount,
            minFill: LOT,
            nonce: 1,
            deadline: OCT_09
        });
    }

    function _sign(QuoteSettlement.Quote memory q) internal view returns (bytes memory) {
        return _signWith(quoterKey, market, q);
    }

    function _signWith(uint256 key, CoreHarness target, QuoteSettlement.Quote memory q)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _claimants() internal view returns (address[] memory owners) {
        owners = new address[](6);
        (owners[0], owners[1], owners[2], owners[3], owners[4], owners[5]) =
        (alice, bob, carol, maker, quoter, treasury);
    }

    function test_aFillPaysTheHolderThePremiumAndMintsLongsToTheMaker() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes memory sig = _sign(q);
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #then
        assertEq(market.claimable(alice, usdg), PREMIUM);
        assertEq(IERC20(usdg).balanceOf(quoter), QUOTER_USDG - PREMIUM);
        assertEq(market.balanceOf(quoter, callSeries), ONE);
        assertEq(market.orderOf(id).committed, ONE);
        _assertConserved(_claimants());
    }

    function test_theMakerPaysTheFeeOnTopAndTheHolderGetsTheFullPremium() public {
        // #given
        market.setFee(100, treasury);
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        q.maxFeeBps = 100;
        uint256 fee = Units.fee(PREMIUM, 100);
        bytes memory sig = _sign(q);
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #then
        assertEq(market.claimable(alice, usdg), PREMIUM);
        assertEq(market.claimable(treasury, usdg), fee);
        assertEq(IERC20(usdg).balanceOf(quoter), QUOTER_USDG - PREMIUM - fee);
        _assertConserved(_claimants());
    }

    function test_aQuoteFillsAcrossOrdersUpToItsMaximumAndNoFurther() public {
        // #given
        uint256 a = _place(alice, OptionType.Call, ONE);
        uint256 b = _place(bob, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes memory sig = _sign(q);
        market.fillQuote(q, sig, a, ONE / 2);
        market.fillQuote(q, sig, b, ONE / 2);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                QuoteSettlement.QuoteOverfilled.selector, market.quoteDigest(q), ONE, LOT, ONE
            )
        );
        // #when
        market.fillQuote(q, sig, a, LOT);
    }

    function test_aFillBelowTheMinimumIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, 3 * LOT);
        q.minFill = 2 * LOT;
        bytes memory sig = _sign(q);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(QuoteSettlement.BelowMinimumFill.selector, LOT, 2 * LOT)
        );
        // #when
        market.fillQuote(q, sig, id, LOT);
    }

    function test_theLastFillMayTakeLessThanTheMinimum() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, 3 * LOT);
        q.minFill = 2 * LOT;
        bytes memory sig = _sign(q);
        market.fillQuote(q, sig, id, 2 * LOT);
        // #when
        market.fillQuote(q, sig, id, LOT);
        // #then
        assertEq(market.quoteFilled(market.quoteDigest(q)), 3 * LOT);
    }

    function test_aQuoteSignedForAnotherChainDoesntVerify() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes memory sig = _sign(q);
        // #when: the same contract and quote seen from a different chain ID
        vm.chainId(block.chainid + 1);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.BadSignature.selector, quoter));
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aQuoteSignedForAnotherDeploymentDoesntVerify() public {
        // #given: a second deployment with its own epoch and an order in the same series
        CoreHarness other = new CoreHarness(calendar, registry, adapter, liveness);
        (uint80 round,,) = _lastRoundAtOrBefore(OCT_02);
        other.createEpoch(nvda, round);
        other.seriesFor(nvda, OCT_09, OptionType.Call, callStrike);
        vm.startPrank(alice);
        IERC20(nvda).approve(address(other), type(uint256).max);
        uint256 id = other.placeOrder(_params(OptionType.Call, callStrike, ONE));
        vm.stopPrank();
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes memory sigForFirst = _sign(q);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.BadSignature.selector, quoter));
        // #when
        other.fillQuote(q, sigForFirst, id, ONE);
    }

    function test_aQuoteForOneHolderCantFillAnothersOrder() public {
        // #given
        uint256 id = _place(bob, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        q.taker = alice;
        bytes memory sig = _sign(q);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.TakerMismatch.selector, alice, bob));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aQuoteCantFillAnOrderInAnotherSeries() public {
        // #given
        uint256 id = _place(alice, OptionType.Put, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes memory sig = _sign(q);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.SeriesMismatch.selector, id, callSeries)
        );
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_anExpiredQuoteIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        q.deadline = OCT_02 + 15 minutes;
        bytes memory sig = _sign(q);
        vm.warp(OCT_02 + 16 minutes);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.QuoteExpired.selector, q.deadline));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aDeadlineBeyondTheSeriesExpiryIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        q.deadline = OCT_09 + 1;
        bytes memory sig = _sign(q);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(QuoteSettlement.DeadlineAfterExpiry.selector, OCT_09 + 1, OCT_09)
        );
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aPremiumBelowTheHoldersFloorIsRefused() public {
        // #given
        CollateralVault.OrderParams memory p = _params(OptionType.Call, callStrike, ONE);
        p.minPremium = PREMIUM + PRICE_TICK;
        vm.prank(alice);
        uint256 id = market.placeOrder(p);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes memory sig = _sign(q);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                QuoteSettlement.BelowMinimumPremium.selector, PREMIUM, PREMIUM + PRICE_TICK
            )
        );
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aPremiumOffThePriceTickIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        q.premium = PREMIUM + 1;
        bytes memory sig = _sign(q);
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotOnTick.selector, PREMIUM + 1, PRICE_TICK));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aCancelledQuoteCantBeFilled() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes memory sig = _sign(q);
        vm.prank(quoter);
        market.cancelQuote(q);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                QuoteSettlement.QuoteOverfilled.selector, market.quoteDigest(q), ONE, LOT, ONE
            )
        );
        // #when
        market.fillQuote(q, sig, id, LOT);
    }

    function test_raisingTheNonceFloorCancelsEveryOlderQuote() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        q.nonce = 2;
        bytes memory sig = _sign(q);
        vm.prank(quoter);
        market.invalidateNonces(3);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.NonceInvalidated.selector, 2, 3));
        // #when
        market.fillQuote(q, sig, id, LOT);
    }

    function test_onlyTheMakerCanCancelItsQuote() public {
        // #given
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(QuoteSettlement.NotQuoteMaker.selector, alice, quoter)
        );
        // #when
        vm.prank(alice);
        market.cancelQuote(q);
    }

    function test_aFeeAboveTheRateTheMakerSignedIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        q.maxFeeBps = 50;
        bytes memory sig = _sign(q);
        market.setFee(100, treasury);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.FeeAboveQuote.selector, 100, 50));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_feesAboveTheCapAreRefused() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.FeeTooHigh.selector, uint16(501)));
        // #when
        market.setFee(501, treasury);
    }

    function test_fillsByATeamMakerAreTaggedOnChain() public {
        // #given
        market.setTeamOperated(quoter, true);
        uint256 id = _place(alice, OptionType.Call, ONE);
        QuoteSettlement.Quote memory q = _quote(callSeries, ONE);
        bytes32 digest = market.quoteDigest(q);
        bytes memory sig = _sign(q);
        // #then
        vm.expectEmit(address(market));
        emit QuoteSettlement.QuoteFilled(
            digest, quoter, id, callSeries, ONE, PREMIUM, PREMIUM, 0, true
        );
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aContractMakerSignsThroughErc1271() public {
        // #given
        (MakerWallet wallet, QuoteSettlement.Quote memory q, bytes memory sig, uint256 id) =
            _walletQuote();
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #then
        assertEq(market.balanceOf(address(wallet), callSeries), ONE);
    }

    function test_theMakerHasPaidBeforeItsLongsArrive() public {
        // #given
        (MakerWallet wallet, QuoteSettlement.Quote memory q, bytes memory sig, uint256 id) =
            _walletQuote();
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #then
        assertEq(wallet.usdgAtMint(), QUOTER_USDG - PREMIUM);
    }

    function test_theMintCallbackCantReenterTheMarket() public {
        // #given
        (MakerWallet wallet, QuoteSettlement.Quote memory q, bytes memory sig, uint256 id) =
            _walletQuote();
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #then
        assertEq(
            wallet.reentryError(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
    }

    function _walletQuote()
        internal
        returns (MakerWallet wallet, QuoteSettlement.Quote memory q, bytes memory sig, uint256 id)
    {
        (address walletOwner, uint256 walletKey) = makeAddrAndKey("walletOwner");
        wallet = new MakerWallet(walletOwner, IERC20(usdg), market);
        _fundUsdg(address(wallet));
        id = _place(alice, OptionType.Call, ONE);
        q = _quote(callSeries, ONE);
        q.maker = address(wallet);
        sig = _signWith(walletKey, market, q);
    }
}
