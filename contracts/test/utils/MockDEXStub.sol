// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMockDEX} from "../../src/interfaces/IMockDEX.sol";
import {TestToken} from "./TestToken.sol";

/// @notice The smallest IMockDEX, for tests only, until Person B's mock lands in contracts/src/mocks/
/// @dev It takes the input token and mints the output token, so it needs no liquidity.
// TODO: Replace with Person B's MockDEX from contracts/src/mocks/ once it lands.
contract MockDEXStub is IMockDEX {
    address public immutable quoteToken;

    error ZeroPrice();

    constructor(address quoteToken_) {
        quoteToken = quoteToken_;
    }

    function buy(address asset, uint256 quoteIn, uint256 price) external returns (uint256 assetOut) {
        if (price == 0) revert ZeroPrice();
        TestToken(quoteToken).transferFrom(msg.sender, address(this), quoteIn);
        uint256 assetUnit = 10 ** TestToken(asset).decimals();
        uint256 quoteUnit = 10 ** TestToken(quoteToken).decimals();
        // assetOut = quoteIn / quoteUnit / (price / 1e18) * assetUnit
        assetOut = Math.mulDiv(quoteIn * assetUnit, 1e18, price * quoteUnit);
        TestToken(asset).mint(msg.sender, assetOut);
    }

    function sell(address asset, uint256 assetIn, uint256 price) external returns (uint256 quoteOut) {
        if (price == 0) revert ZeroPrice();
        TestToken(asset).transferFrom(msg.sender, address(this), assetIn);
        uint256 assetUnit = 10 ** TestToken(asset).decimals();
        uint256 quoteUnit = 10 ** TestToken(quoteToken).decimals();
        // quoteOut = assetIn / assetUnit * (price / 1e18) * quoteUnit
        quoteOut = Math.mulDiv(assetIn * quoteUnit, price, assetUnit * 1e18);
        TestToken(quoteToken).mint(msg.sender, quoteOut);
    }
}
