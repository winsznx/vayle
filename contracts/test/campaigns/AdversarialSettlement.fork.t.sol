// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {StockTokenRegistry} from "../../src/assets/StockTokenRegistry.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {OptionSeries} from "../../src/core/OptionSeries.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";
import {SettlementEngine} from "../../src/core/SettlementEngine.sol";
import {OptionType} from "../../src/libraries/SeriesId.sol";
import {Units} from "../../src/libraries/Units.sol";
import {ChainActors} from "../utils/ChainActors.sol";
import {MakerWallet} from "../utils/MakerWallet.sol";
import {VayleMarketFork} from "../utils/VayleMarketFork.sol";

/// @notice Campaign C, adversarial settlement, against the deployable market on real tokens.
contract AdversarialSettlementForkTest is VayleMarketFork {
    /// @dev The window opens at OCT_09 and, with the keeper pinging, ends two hours later.
    uint64 internal constant WINDOW_END = OCT_09 + 2 hours;

    // Double exercise

    function test_spentLongsCantBeExercisedAgain() public {
        // #given
        _writeCall(alice, ONE);
        _intoTheWindow();
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.ExceedsWritten.selector, callSeries, LOT, 0)
        );
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, LOT);
    }

    function test_transferredLongsCantBeExercisedByTheirOldHolder() public {
        // #given: the maker sells half its longs to bob
        _writeCall(alice, ONE);
        vm.prank(quoter);
        market.safeTransferFrom(quoter, bob, callSeries, ONE / 2, "");
        _intoTheWindow();
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector, quoter, ONE / 2, ONE, callSeries
            )
        );
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
    }

    function test_transferredLongsExerciseOnceInTotal() public {
        // #given
        _writeCall(alice, ONE);
        vm.prank(quoter);
        market.safeTransferFrom(quoter, bob, callSeries, ONE / 2, "");
        _intoTheWindow();
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE / 2);
        vm.prank(bob);
        market.exercise(callSeries, ONE / 2);
        // #then
        CollateralVault.Pool memory pool = market.poolOf(callSeries);
        assertEq(pool.exercised, pool.written);
        assertEq(market.totalSupply(callSeries), 0);
        _assertConserved(_claimants());
    }

    // Replayed and stale quotes

    function test_aFilledQuoteCantBeReplayed() public {
        // #given
        uint256 a = _place(alice, OptionType.Call, ONE);
        uint256 b = _place(bob, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        market.fillQuote(q, sig, a, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                QuoteSettlement.QuoteOverfilled.selector, market.quoteDigest(q), ONE, ONE, ONE
            )
        );
        // #when
        market.fillQuote(q, sig, b, ONE);
    }

    function test_aQuoteCantBeReplayedOnAnotherChain() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.chainId(block.chainid + 1);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.BadSignature.selector, quoter));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_aQuotePastItsDeadlineIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q,) = _signedQuote(callSeries, ONE);
        q.deadline = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoterKey, market.quoteDigest(q));
        vm.warp(q.deadline + 1);
        // #then
        vm.expectRevert(abi.encodeWithSelector(QuoteSettlement.QuoteExpired.selector, q.deadline));
        // #when
        market.fillQuote(q, abi.encodePacked(r, s, v), id, ONE);
    }

    // Wrong series, token or USDG

    function test_aQuoteForAnUnknownSeriesIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(42, ONE);
        // #then
        vm.expectRevert(abi.encodeWithSelector(OptionSeries.UnknownSeries.selector, 42));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_exercisingAnUnknownSeriesIsRefused() public {
        // #given
        _intoTheWindow();
        // #then
        vm.expectRevert(abi.encodeWithSelector(OptionSeries.UnknownSeries.selector, 42));
        // #when
        vm.prank(quoter);
        market.exercise(42, LOT);
    }

    function test_aCallOrderCantBeFilledIntoThePutSeries() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(putSeries, ONE);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.SeriesMismatch.selector, id, putSeries)
        );
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    function test_anOrderForAnUnlistedTokenIsRefused() public {
        // #given
        CollateralVault.OrderParams memory p = _params(OptionType.Call, callStrike, ONE);
        p.asset = usdg;
        // #then
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotListed.selector, usdg));
        // #when
        vm.prank(alice);
        market.placeOrder(p);
    }

    function test_seriesCollateralIsBoundToTheListedTokenAndRealUsdg() public view {
        // #then
        assertEq(market.seriesKey(callSeries).collateralToken, nvda);
        assertEq(market.seriesKey(putSeries).collateralToken, usdg);
        assertEq(market.usdg(), usdg);
    }

    function test_tokensSentStraightToTheMarketChangeNoClaim() public {
        // #given: a written call and a stranger donating NVDA and USDG
        _writeCall(alice, ONE);
        address stranger = makeAddr("stranger");
        _fund(stranger, ONE, 1_000e6);
        uint256 aliceClaim = market.claimable(alice, usdg);
        // #when
        vm.startPrank(stranger);
        IERC20(nvda).transfer(address(market), ONE);
        IERC20(usdg).transfer(address(market), 1_000e6);
        vm.stopPrank();
        // #then
        assertEq(market.claimable(alice, usdg), aliceClaim);
        assertEq(market.claimable(stranger, usdg), 0);
        assertEq(market.poolOf(callSeries).collateral, ONE);
    }

    function test_donatedTokensCantBeWithdrawn() public {
        // #given
        address stranger = makeAddr("stranger");
        vm.prank(ChainActors.FUNDING_SOURCE);
        IERC20(usdg).transfer(stranger, 1_000e6);
        vm.prank(stranger);
        IERC20(usdg).transfer(address(market), 1_000e6);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.InsufficientClaimable.selector, stranger, usdg, 1_000e6, 0
            )
        );
        // #when
        vm.prank(stranger);
        market.withdraw(usdg, 1_000e6);
    }

    // Reentrancy

    function test_aMakerContractCantReenterDuringItsMint() public {
        // #given
        (address walletOwner, uint256 walletKey) = makeAddrAndKey("walletOwner");
        MakerWallet wallet = new MakerWallet(walletOwner, IERC20(usdg), market);
        vm.prank(ChainActors.FUNDING_SOURCE);
        IERC20(usdg).transfer(address(wallet), 10_000e6);
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q,) = _signedQuote(callSeries, ONE);
        q.maker = address(wallet);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletKey, market.quoteDigest(q));
        // #when
        market.fillQuote(q, abi.encodePacked(r, s, v), id, ONE);
        // #then
        assertEq(
            wallet.reentryError(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
    }

    // Boundary timestamps

    function test_exerciseOneSecondBeforeExpiryIsRefused() public {
        // #given
        _writeCall(alice, ONE);
        _keepAlive(OCT_09 - 10 minutes, OCT_09 - 1 minutes);
        vm.warp(OCT_09 - 1);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEngine.WindowNotOpen.selector, callSeries, OCT_09)
        );
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
    }

    function test_exerciseAtExpiryIsAccepted() public {
        // #given
        _writeCall(alice, ONE);
        _keepAlive(OCT_09 - 10 minutes, OCT_09);
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        // #then
        assertEq(market.poolOf(callSeries).exercised, ONE);
    }

    function test_exerciseInTheWindowsLastSecondIsAccepted() public {
        // #given
        _writeCall(alice, ONE);
        _keepAlive(OCT_09 - 10 minutes, WINDOW_END - 1 minutes);
        vm.warp(WINDOW_END - 1);
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
        // #then
        assertEq(market.poolOf(callSeries).exercised, ONE);
    }

    function test_exerciseAtTheWindowsEndIsRefused() public {
        // #given
        _writeCall(alice, ONE);
        _keepAlive(OCT_09 - 10 minutes, WINDOW_END);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEngine.WindowClosed.selector, callSeries, WINDOW_END)
        );
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, ONE);
    }

    function test_finalizeBeforeTheWindowsEndIsRefused() public {
        // #given
        _writeCall(alice, ONE);
        _keepAlive(OCT_09 - 10 minutes, WINDOW_END - 1 minutes);
        vm.warp(WINDOW_END - 1);
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEngine.WindowStillOpen.selector, callSeries, WINDOW_END
            )
        );
        // #when
        market.finalize(callSeries);
    }

    function test_aFillOneSecondBeforeExpiryIsAccepted() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.warp(OCT_09 - 1);
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #then
        assertEq(market.poolOf(callSeries).written, ONE);
    }

    function test_aFillAtExpiryIsRefused() public {
        // #given
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuote(callSeries, ONE);
        vm.warp(OCT_09);
        // #then
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.SeriesClosed.selector, callSeries));
        // #when
        market.fillQuote(q, sig, id, ONE);
    }

    // Partial fills and dust

    function test_interleavedPartialFillsConserveEveryToken() public {
        // #given: three orders and two quotes, filled in uneven slices
        uint256 a = _place(alice, OptionType.Call, ONE);
        uint256 b = _place(bob, OptionType.Call, ONE);
        uint256 c = _place(carol, OptionType.Put, ONE);
        (QuoteSettlement.Quote memory big, bytes memory bigSig) =
            _signedQuoteAt(callSeries, 2 * ONE, PREMIUM);
        (QuoteSettlement.Quote memory put, bytes memory putSig) =
            _signedQuoteAt(putSeries, ONE, PREMIUM + PRICE_TICK);
        // #when
        market.fillQuote(big, bigSig, a, 3 * LOT);
        market.fillQuote(put, putSig, c, 7 * LOT);
        market.fillQuote(big, bigSig, b, 61 * LOT);
        market.fillQuote(big, bigSig, a, 97 * LOT);
        market.fillQuote(put, putSig, c, 93 * LOT);
        // #then
        assertEq(market.quoteFilled(market.quoteDigest(big)), ONE + 61 * LOT);
        assertEq(market.orderOf(a).committed, ONE);
        _assertConserved(_claimants());
    }

    function test_aSizeThatIsntWholeLotsIsRefused() public {
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotALot.selector, LOT + 1, LOT));
        // #when
        _place(alice, OptionType.Call, LOT + 1);
    }

    function test_exercisingDustIsRefused() public {
        // #given
        _writeCall(alice, ONE);
        _intoTheWindow();
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotALot.selector, 1, LOT));
        // #when
        vm.prank(quoter);
        market.exercise(callSeries, 1);
    }

    function test_aDustFillIsRefused() public {
        // #given: a quote that allows any fill size
        uint256 id = _place(alice, OptionType.Call, ONE);
        (QuoteSettlement.Quote memory q,) = _signedQuote(callSeries, ONE);
        q.minFill = 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoterKey, market.quoteDigest(q));
        // #then
        vm.expectRevert(abi.encodeWithSelector(Units.NotALot.selector, LOT / 2, LOT));
        // #when
        market.fillQuote(q, abi.encodePacked(r, s, v), id, LOT / 2);
    }

    function test_aTargetOffTheStrikeTickIsRefused() public {
        // #then
        vm.expectRevert(
            abi.encodeWithSelector(Units.NotOnTick.selector, callStrike + 1, STRIKE_TICK)
        );
        // #when
        vm.prank(alice);
        market.placeOrder(_params(OptionType.Call, callStrike + 1, ONE));
    }

    // Max-size trades

    function test_aFillExactlyAtTheFillAndSeriesCapsSucceeds() public {
        // #given: four tokens already written, then a fill of exactly the two-token fill cap
        _writeCall(alice, 2 * ONE);
        _writeCall(bob, 2 * ONE);
        uint256 id = _place(carol, OptionType.Call, 2 * ONE);
        // #when
        _fillQuote(id, callSeries, 2 * ONE);
        // #then
        assertEq(market.poolOf(callSeries).written, 6 * ONE);
    }

    function test_anAbsurdPremiumRevertsWithoutChangingState() public {
        // #given: a quote whose premium the maker can't possibly pay
        uint256 id = _place(alice, OptionType.Call, ONE);
        uint256 absurd = (uint256(type(uint128).max) / PRICE_TICK) * PRICE_TICK;
        (QuoteSettlement.Quote memory q, bytes memory sig) = _signedQuoteAt(callSeries, ONE, absurd);
        // #then
        vm.expectRevert();
        // #when
        market.fillQuote(q, sig, id, ONE);
        // #then
        assertEq(market.orderOf(id).committed, 0);
        assertEq(market.quoteFilled(market.quoteDigest(q)), 0);
    }
}
