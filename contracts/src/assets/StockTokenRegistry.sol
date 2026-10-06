// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPriceFeed} from "../interfaces/IPriceFeed.sol";
import {IScaledUIAmount, IScaledUIAmountPending, IStockToken} from "../interfaces/IStockToken.sol";
import {ExternalReads} from "../libraries/ExternalReads.sol";
import {Units} from "../libraries/Units.sol";

/// @title StockTokenRegistry
/// @notice The Stock Tokens Vayle lists, each with its price feed and its order and strike grid.
/// @dev Owned by the timelocked admin. A token's identity is its issuer uid, checked on chain when
/// it's listed. Live series copy what they need when they're created and never read this registry
/// again, so delisting only stops new epochs. Reads that fail revert ExternalReads.NotAStockToken
/// or ExternalReads.FeedUnusable.
contract StockTokenRegistry is Ownable2Step {
    uint256 internal constant MAX_STRIKE_RANGE_BPS = 10_000;

    struct Asset {
        bytes32 uid;
        IPriceFeed feed;
        uint8 decimals;
        uint8 feedDecimals;
        uint256 rawUnit;
        uint256 lot;
        uint256 priceTick;
        uint256 strikeTick;
        uint16 strikeRangeBps;
        bool listed;
    }

    IERC20Metadata public immutable usdg;
    uint8 public immutable usdgDecimals;

    mapping(address token => Asset) private _assets;

    event AssetListed(
        address indexed token,
        bytes32 uid,
        address feed,
        uint256 lot,
        uint256 priceTick,
        uint256 strikeTick,
        uint16 strikeRangeBps
    );
    event AssetDelisted(address indexed token);

    error NotAContract(address account);
    error UidMismatch(address token, bytes32 expected, bytes32 actual);
    error InterfaceNotSupported(address token, bytes4 interfaceId);
    error InexactGrid(uint256 lot, uint256 priceTick, uint256 rawUnit);
    error BadStrikeGrid(uint256 strikeTick, uint256 priceTick, uint16 strikeRangeBps);
    error AlreadyListed(address token);
    error NotListed(address token);

    constructor(address initialOwner, IERC20Metadata usdg_) Ownable(initialOwner) {
        usdg = usdg_;
        usdgDecimals = usdg_.decimals();
    }

    function list(
        address token,
        bytes32 uid,
        IPriceFeed feed,
        uint256 lot,
        uint256 priceTick,
        uint256 strikeTick,
        uint16 strikeRangeBps
    ) external onlyOwner {
        if (_assets[token].listed) revert AlreadyListed(token);
        if (token.code.length == 0) revert NotAContract(token);
        _checkIdentity(IStockToken(token), uid);
        uint8 tokenDecimals = ExternalReads.tokenDecimals(token);
        uint256 rawUnit = 10 ** tokenDecimals;
        uint8 feedDecimals = _checkFeed(feed);
        if (!Units.gridIsExact(lot, priceTick, rawUnit)) {
            revert InexactGrid(lot, priceTick, rawUnit);
        }
        if (
            strikeTick == 0 || strikeTick % priceTick != 0 || strikeRangeBps == 0
                || strikeRangeBps >= MAX_STRIKE_RANGE_BPS
        ) {
            revert BadStrikeGrid(strikeTick, priceTick, strikeRangeBps);
        }
        _assets[token] = Asset({
            uid: uid,
            feed: feed,
            decimals: tokenDecimals,
            feedDecimals: feedDecimals,
            rawUnit: rawUnit,
            lot: lot,
            priceTick: priceTick,
            strikeTick: strikeTick,
            strikeRangeBps: strikeRangeBps,
            listed: true
        });
        emit AssetListed(token, uid, address(feed), lot, priceTick, strikeTick, strikeRangeBps);
    }

    function delist(address token) external onlyOwner {
        if (!_assets[token].listed) revert NotListed(token);
        _assets[token].listed = false;
        emit AssetDelisted(token);
    }

    function asset(address token) external view returns (Asset memory) {
        Asset memory listed = _assets[token];
        if (!listed.listed) revert NotListed(token);
        return listed;
    }

    function isListed(address token) external view returns (bool) {
        return _assets[token].listed;
    }

    function _checkIdentity(IStockToken token, bytes32 uid) private view {
        (bool ok, bytes memory data) =
            address(token).staticcall(abi.encodeCall(IStockToken.uid, ()));
        if (!ok || data.length != 32) revert ExternalReads.NotAStockToken(address(token));
        bytes32 actual = abi.decode(data, (bytes32));
        if (actual != uid) revert UidMismatch(address(token), uid, actual);
        _requireInterface(token, type(IScaledUIAmount).interfaceId);
        _requireInterface(token, type(IScaledUIAmountPending).interfaceId);
        // The price adapter and the close observations act on the flag. Listing only needs it.
        ExternalReads.requireOracleFlag(address(token));
    }

    function _requireInterface(IStockToken token, bytes4 interfaceId) private view {
        if (!_supports(token, interfaceId)) {
            revert InterfaceNotSupported(address(token), interfaceId);
        }
    }

    function _supports(IStockToken token, bytes4 interfaceId) private view returns (bool) {
        try token.supportsInterface(interfaceId) returns (bool supported) {
            return supported;
        } catch {
            return false;
        }
    }

    /// @dev Listing only checks that the feed answers. Staleness is enforced at each close by the
    /// price adapter.
    function _checkFeed(IPriceFeed feed) private view returns (uint8 feedDecimals) {
        if (address(feed).code.length == 0) revert NotAContract(address(feed));
        feedDecimals = ExternalReads.feedDecimals(address(feed));
        int256 answer = ExternalReads.latestAnswer(address(feed));
        if (feedDecimals < usdgDecimals || answer <= 0) {
            revert ExternalReads.FeedUnusable(address(feed));
        }
    }
}
