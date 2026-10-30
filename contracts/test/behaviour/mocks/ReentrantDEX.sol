// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockDEX} from "../../../src/mocks/MockDEX.sol";
import {ForwardingDEX} from "./ForwardingDEX.sol";
import {Reenterer} from "./Reenterer.sol";

/// @notice A DEX that calls back into the vault in the middle of a buy or sell, after it has swapped on the real MockDEX
/// and before it sends the output on
contract ReentrantDEX is ForwardingDEX, Reenterer {
    constructor(MockDEX inner_) ForwardingDEX(inner_) {}

    function buy(address asset, uint256 quoteIn, uint256 price) external returns (uint256 assetOut) {
        assetOut = _buyOnInner(asset, quoteIn, price);
        _reenter(this.buy.selector);
        _send(asset, assetOut);
    }

    function sell(address asset, uint256 assetIn, uint256 price) external returns (uint256 quoteOut) {
        quoteOut = _sellOnInner(asset, assetIn, price);
        _reenter(this.sell.selector);
        _send(quoteToken(), quoteOut);
    }
}
