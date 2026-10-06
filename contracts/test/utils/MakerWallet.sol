// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {QuoteSettlement} from "../../src/core/QuoteSettlement.sol";

/// @notice A smart-account maker. It signs quotes through ERC-1271 with its owner's key and, when
/// longs arrive, records its USDG balance and tries to reenter the market.
contract MakerWallet is IERC1271, IERC1155Receiver {
    address internal immutable owner;
    IERC20 internal immutable usdg;
    QuoteSettlement internal immutable market;

    uint256 public usdgAtMint;
    bool public reentered;
    bytes public reentryError;

    constructor(address owner_, IERC20 usdg_, QuoteSettlement market_) {
        (owner, usdg, market) = (owner_, usdg_, market_);
        usdg_.approve(address(market_), type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        return ECDSA.recover(hash, signature) == owner ? this.isValidSignature.selector : bytes4(0);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        usdgAtMint = usdg.balanceOf(address(this));
        try market.invalidateNonces(1) {
            reentered = true;
        } catch (bytes memory reason) {
            reentryError = reason;
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }
}
