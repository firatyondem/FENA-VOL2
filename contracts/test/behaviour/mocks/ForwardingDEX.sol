// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMockDEX} from "../../../src/interfaces/IMockDEX.sol";
import {MockDEX} from "../../../src/mocks/MockDEX.sol";

/// @notice Base of the hostile DEXes: every swap goes through Person B's real MockDEX, so a swap is real unless a
/// subclass breaks it on purpose
/// @dev The vault approves this contract, which pulls the input, swaps it on the real DEX and keeps the output until the
/// subclass sends it on with _send.
abstract contract ForwardingDEX is IMockDEX {
    using SafeERC20 for IERC20;

    MockDEX public immutable inner;
    IERC20 private immutable _quote;

    constructor(MockDEX inner_) {
        inner = inner_;
        _quote = IERC20(inner_.quoteToken());
    }

    /// @inheritdoc IMockDEX
    function quoteToken() public view returns (address) {
        return address(_quote);
    }

    /// @dev Pulls `quoteIn` from the caller and buys `asset` on the real DEX; the asset stays here
    function _buyOnInner(address asset, uint256 quoteIn, uint256 price) internal returns (uint256 assetOut) {
        _quote.safeTransferFrom(msg.sender, address(this), quoteIn);
        _quote.forceApprove(address(inner), quoteIn);
        assetOut = inner.buy(asset, quoteIn, price);
    }

    /// @dev Pulls `assetIn` from the caller and sells it on the real DEX; the quote tokens stay here
    function _sellOnInner(address asset, uint256 assetIn, uint256 price) internal returns (uint256 quoteOut) {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assetIn);
        IERC20(asset).forceApprove(address(inner), assetIn);
        quoteOut = inner.sell(asset, assetIn, price);
    }

    function _send(address token, uint256 amount) internal {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}
