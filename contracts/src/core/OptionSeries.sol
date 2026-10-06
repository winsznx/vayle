// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {SeriesId, SeriesKey} from "../libraries/SeriesId.sol";

/// @title OptionSeries
/// @notice Long option positions as ERC-1155 tokens. The token ID is the series ID, and a
/// balance is the raw underlying amount the option covers.
/// @dev Series are registered the first time a fill path uses them. Longs transfer freely, and
/// writer positions live in the vault, not here.
abstract contract OptionSeries is ERC1155Supply {
    mapping(uint256 id => SeriesKey) private _keys;

    event SeriesRegistered(uint256 indexed id, SeriesKey key);

    error UnknownSeries(uint256 id);

    constructor() ERC1155("") {}

    function seriesKey(uint256 id) external view returns (SeriesKey memory) {
        if (!_isRegistered(id)) revert UnknownSeries(id);
        return _keys[id];
    }

    function _isRegistered(uint256 id) internal view returns (bool) {
        return _keys[id].expiry != 0;
    }

    function _key(uint256 id) internal view returns (SeriesKey storage key) {
        key = _keys[id];
        if (key.expiry == 0) revert UnknownSeries(id);
    }

    function _register(SeriesKey memory key) internal returns (uint256 id) {
        id = SeriesId.id(key);
        if (!_isRegistered(id)) {
            _keys[id] = key;
            emit SeriesRegistered(id, key);
        }
    }
}
