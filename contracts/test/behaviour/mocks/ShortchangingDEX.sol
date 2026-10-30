// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockDEX} from "../../../src/mocks/MockDEX.sol";
import {ForwardingDEX} from "./ForwardingDEX.sol";

/// @notice A DEX that returns the full output that IMockDEX promises but keeps a share of it
/// @dev The return value is the real MockDEX's output at the verified price, as IMockDEX defines it; only
/// output * (10_000 - shortfall) / 10_000 reaches the caller.
contract ShortchangingDEX is ForwardingDEX {
    uint16 public buyShortfallBps;
    uint16 public sellShortfallBps;

    constructor(MockDEX inner_) ForwardingDEX(inner_) {}

    function setShortfall(uint16 buyShortfallBps_, uint16 sellShortfallBps_) external {
        buyShortfallBps = buyShortfallBps_;
        sellShortfallBps = sellShortfallBps_;
    }

    function buy(address asset, uint256 quoteIn, uint256 price) external returns (uint256 assetOut) {
        assetOut = _buyOnInner(asset, quoteIn, price);
        _send(asset, assetOut - assetOut * buyShortfallBps / 10_000);
    }

    function sell(address asset, uint256 assetIn, uint256 price) external returns (uint256 quoteOut) {
        quoteOut = _sellOnInner(asset, assetIn, price);
        _send(quoteToken(), quoteOut - quoteOut * sellShortfallBps / 10_000);
    }
}
