// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A mock DEX that swaps at a price the caller has already verified
/// @notice The vault verifies a signed AirnodeHub price, then swaps at exactly that price. The DEX does no pricing of
/// its own, so it is only for testnets.
/// @dev Both swaps pull the input token from the caller with transferFrom, so the caller approves it first, and send the
/// output token to the caller. `price` is the price of one whole asset token in quote tokens, with 18 decimals, as
/// ProjectedJson.readUint(data, "price", 18) reads it. The DEX converts between the token decimals itself.
interface IMockDEX {
    /// @notice The token that the vault holds and pays with, such as mock USDC
    function quoteToken() external view returns (address);

    /// @notice Pays `quoteIn` quote tokens for `asset` at `price`
    /// @return assetOut Amount of `asset` sent to the caller
    function buy(address asset, uint256 quoteIn, uint256 price) external returns (uint256 assetOut);

    /// @notice Sells `assetIn` of `asset` for quote tokens at `price`
    /// @return quoteOut Amount of quote tokens sent to the caller
    function sell(address asset, uint256 assetIn, uint256 price) external returns (uint256 quoteOut);
}
