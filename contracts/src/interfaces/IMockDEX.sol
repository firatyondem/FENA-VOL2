// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A mock DEX that swaps at a price the caller has already verified
/// @notice The vault has Pyth verify a price, then swaps at exactly that price. The DEX does no pricing of
/// its own, so it is only for testnets.
/// @dev The DEX holds no liquidity, so anyone may call it. buy pulls exactly quoteIn of quoteToken() from the caller with
/// transferFrom (approve first) and mints assetOut = quoteIn * 10**assetDecimals * 1e18 / (price * 10**quoteDecimals),
/// rounded down, of asset to the caller. sell pulls exactly assetIn of asset and mints
/// quoteOut = assetIn * price * 10**quoteDecimals / (10**assetDecimals * 1e18), rounded down, of quoteToken() to the
/// caller. The quote token and every asset token must therefore let the DEX mint. `price` is the price of one whole
/// asset token in quote tokens, with 18 decimals, as the vault scales a Pyth price; price 0 reverts.
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
