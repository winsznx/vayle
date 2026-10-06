// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {SeriesKey} from "../libraries/SeriesId.sol";
import {Units} from "../libraries/Units.sol";
import {SettlementEngine} from "./SettlementEngine.sol";

/// @title QuoteSettlement
/// @notice Fills holder orders against signed maker bids.
/// @dev A quote is an EIP-712 bid to buy options in one series. Anyone may match it to a holder's
/// standing order. The holder consented through the order and its premium floor, the maker through
/// the signature. The maker pays the premium plus the protocol fee, never more than the fee rate it
/// signed, and the premium is collected before any long is minted.
abstract contract QuoteSettlement is SettlementEngine, EIP712 {
    uint16 public constant MAX_FEE_BPS = 500;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address taker,uint256 series,uint256 premium,uint16 maxFeeBps,uint256 maxAmount,uint256 minFill,uint256 nonce,uint64 deadline)"
    );

    struct Quote {
        address maker;
        address taker;
        uint256 series;
        uint256 premium;
        uint16 maxFeeBps;
        uint256 maxAmount;
        uint256 minFill;
        uint256 nonce;
        uint64 deadline;
    }

    uint16 public feeBps;
    address public feeRecipient;
    mapping(address maker => bool) public teamOperated;
    mapping(address maker => uint256) public minNonce;
    mapping(bytes32 digest => uint256) public quoteFilled;

    event QuoteFilled(
        bytes32 indexed digest,
        address indexed maker,
        uint256 indexed orderId,
        uint256 series,
        uint256 amount,
        uint256 premium,
        uint256 premiumValue,
        uint256 fee,
        bool teamOperated
    );
    event QuoteCancelled(bytes32 indexed digest, address indexed maker);
    event NoncesInvalidated(address indexed maker, uint256 minNonce);
    event FeeSet(uint16 feeBps, address indexed feeRecipient);
    event TeamOperatedSet(address indexed maker, bool teamOperated);

    error TakerMismatch(address taker, address owner);
    error QuoteExpired(uint64 deadline);
    error DeadlineAfterExpiry(uint64 deadline, uint64 expiry);
    error NonceInvalidated(uint256 nonce, uint256 minNonce);
    error BadSignature(address maker);
    error QuoteOverfilled(bytes32 digest, uint256 filled, uint256 amount, uint256 maxAmount);
    error BelowMinimumFill(uint256 amount, uint256 minFill);
    error BelowMinimumPremium(uint256 premium, uint256 minPremium);
    error FeeAboveQuote(uint16 feeBps, uint16 maxFeeBps);
    error NotQuoteMaker(address caller, address maker);
    error NonceNotIncreasing(uint256 current, uint256 requested);
    error FeeTooHigh(uint16 feeBps);
    error ZeroFeeRecipient();

    constructor() EIP712("Vayle", "1") {}

    function fillQuote(
        Quote calldata quote,
        bytes calldata signature,
        uint256 orderId,
        uint256 amount
    ) external nonReentrant {
        liveness.checkpoint();
        bytes32 digest = _checkQuote(quote, signature, orderId, amount);
        _settleQuote(quote, digest, orderId, amount);
    }

    /// @notice Withdraws one quote. Only its maker can.
    function cancelQuote(Quote calldata quote) external nonReentrant {
        if (msg.sender != quote.maker) revert NotQuoteMaker(msg.sender, quote.maker);
        bytes32 digest = quoteDigest(quote);
        quoteFilled[digest] = quote.maxAmount;
        emit QuoteCancelled(digest, quote.maker);
    }

    /// @notice Withdraws every quote of the caller's with a nonce below `newMinNonce`.
    function invalidateNonces(uint256 newMinNonce) external nonReentrant {
        uint256 current = minNonce[msg.sender];
        if (newMinNonce <= current) revert NonceNotIncreasing(current, newMinNonce);
        minNonce[msg.sender] = newMinNonce;
        emit NoncesInvalidated(msg.sender, newMinNonce);
    }

    function quoteDigest(Quote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    quote.maker,
                    quote.taker,
                    quote.series,
                    quote.premium,
                    quote.maxFeeBps,
                    quote.maxAmount,
                    quote.minFill,
                    quote.nonce,
                    quote.deadline
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @dev Every check a fill must pass, in the order the design lists them.
    function _checkQuote(
        Quote calldata quote,
        bytes calldata signature,
        uint256 orderId,
        uint256 amount
    ) private returns (bytes32 digest) {
        SeriesKey storage key = _key(quote.series);
        Order storage o = _orderStorage(orderId);
        _requireFillsOpen(key.asset);
        if (quote.taker != address(0) && quote.taker != o.owner) {
            revert TakerMismatch(quote.taker, o.owner);
        }
        if (quote.deadline > key.expiry) revert DeadlineAfterExpiry(quote.deadline, key.expiry);
        if (block.timestamp > quote.deadline) revert QuoteExpired(quote.deadline);
        if (quote.nonce < minNonce[quote.maker]) {
            revert NonceInvalidated(quote.nonce, minNonce[quote.maker]);
        }
        digest = quoteDigest(quote);
        if (!SignatureChecker.isValidSignatureNow(quote.maker, digest, signature)) {
            revert BadSignature(quote.maker);
        }
        uint256 filled = quoteFilled[digest];
        if (filled + amount > quote.maxAmount) {
            revert QuoteOverfilled(digest, filled, amount, quote.maxAmount);
        }
        if (amount < quote.minFill && filled + amount != quote.maxAmount) {
            revert BelowMinimumFill(amount, quote.minFill);
        }
        Units.requireOnTick(quote.premium, _epoch(key.asset, key.expiry).priceTick);
        if (quote.premium < o.minPremium) revert BelowMinimumPremium(quote.premium, o.minPremium);
        if (feeBps > quote.maxFeeBps) revert FeeAboveQuote(feeBps, quote.maxFeeBps);
        _checkFillCaps(key.asset, quote.series, amount);
    }

    /// @dev Writes the order into the series, collects premium and fee from the maker, credits
    /// them, and only then mints the longs.
    function _settleQuote(Quote calldata quote, bytes32 digest, uint256 orderId, uint256 amount)
        private
    {
        _commit(orderId, quote.series, amount);
        quoteFilled[digest] += amount;
        SeriesKey storage key = _key(quote.series);
        uint256 premiumValue =
            Units.valueExact(amount, quote.premium, _epoch(key.asset, key.expiry).rawUnit);
        uint256 fee = Units.fee(premiumValue, feeBps);
        emit QuoteFilled(
            digest,
            quote.maker,
            orderId,
            quote.series,
            amount,
            quote.premium,
            premiumValue,
            fee,
            teamOperated[quote.maker]
        );
        _pull(usdg, quote.maker, premiumValue + fee);
        _credit(_orderStorage(orderId).owner, usdg, premiumValue);
        _credit(feeRecipient, usdg, fee);
        _mint(quote.maker, quote.series, amount, "");
    }

    /// @dev Reverts when new fills are paused for the asset. MarketGuard implements it.
    function _requireFillsOpen(address asset) internal view virtual;

    /// @dev Reverts when a fill would breach a launch cap. MarketGuard implements it.
    function _checkFillCaps(address asset, uint256 series, uint256 amount) internal virtual;

    function _setFee(uint16 newFeeBps, address recipient) internal {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps);
        if (recipient == address(0)) revert ZeroFeeRecipient();
        feeBps = newFeeBps;
        feeRecipient = recipient;
        emit FeeSet(newFeeBps, recipient);
    }

    function _setTeamOperated(address maker, bool flag) internal {
        teamOperated[maker] = flag;
        emit TeamOperatedSet(maker, flag);
    }
}
