// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockDEX} from "../../../src/mocks/MockDEX.sol";
import {ForwardingDEX} from "./ForwardingDEX.sol";

/// @notice A DEX that goes down on demand: while a side is down it reverts, otherwise it swaps on the real MockDEX
contract SwitchableDEX is ForwardingDEX {
    bool public isBuyDown;
    bool public isSellDown;

    error DexDown();

    constructor(MockDEX inner_) ForwardingDEX(inner_) {}

    function setDown(bool isBuyDown_, bool isSellDown_) external {
        isBuyDown = isBuyDown_;
        isSellDown = isSellDown_;
    }

    function buy(address asset, uint256 quoteIn, uint256 price) external returns (uint256 assetOut) {
        if (isBuyDown) revert DexDown();
        assetOut = _buyOnInner(asset, quoteIn, price);
        _send(asset, assetOut);
    }

    function sell(address asset, uint256 assetIn, uint256 price) external returns (uint256 quoteOut) {
        if (isSellDown) revert DexDown();
        quoteOut = _sellOnInner(asset, assetIn, price);
        _send(quoteToken(), quoteOut);
    }
}
