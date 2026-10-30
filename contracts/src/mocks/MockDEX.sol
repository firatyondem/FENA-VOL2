// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMockDEX} from "../interfaces/IMockDEX.sol";
import {MockAssetToken} from "./MockAssetToken.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @title Mock DEX that swaps at the price the vault verified
/// @notice There is no pool and no slippage. A buy takes mock USDC and mints the asset token at exactly `price`, a sell
/// takes the asset token, burns it and mints mock USDC at exactly `price`. The DEX trusts the price it is given and holds
/// no liquidity, so, as IMockDEX says, anyone may call it: every token here is a worthless testnet mock, and the vault
/// checks every signed price before it gets here.
/// @dev Prices are USD per whole asset token with 18 decimals, as ProjectedJson.readUint(data, "price", 18) reads them.
contract MockDEX is IMockDEX {
    uint8 public constant PRICE_DECIMALS = 18;

    MockUSDC public immutable usdc;
    address public immutable owner;

    mapping(address asset => bool) public isListed;
    address[] private _listedAssets;

    event AssetListed(address indexed asset, string symbol);
    event Bought(address indexed trader, address indexed asset, uint256 usdcIn, uint256 assetOut, uint256 price);
    event Sold(address indexed trader, address indexed asset, uint256 assetIn, uint256 usdcOut, uint256 price);

    error NotOwner(address caller);
    error ZeroAddress();
    error AssetNotListed(address asset);
    error AssetAlreadyListed(address asset);
    error DexIsNotMinter(address asset);
    error ZeroAmount();
    error ZeroPrice();
    error ZeroOutput();
    error TransferFailed();

    constructor(MockUSDC usdc_, address owner_) {
        if (address(usdc_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @inheritdoc IMockDEX
    function quoteToken() external view returns (address) {
        return address(usdc);
    }

    /// @notice Adds an asset token that this DEX mints, so the vault can buy it
    function listAsset(MockAssetToken asset) external onlyOwner {
        address assetAddress = address(asset);
        if (assetAddress == address(0)) revert ZeroAddress();
        if (isListed[assetAddress]) revert AssetAlreadyListed(assetAddress);
        if (asset.minter() != address(this)) revert DexIsNotMinter(assetAddress);
        isListed[assetAddress] = true;
        _listedAssets.push(assetAddress);
        emit AssetListed(assetAddress, asset.symbol());
    }

    function listedAssets() external view returns (address[] memory) {
        return _listedAssets;
    }

    /// @notice Asset tokens that `usdcIn` buys at `price`, rounded down
    function quoteBuy(address asset, uint256 usdcIn, uint256 price) public view returns (uint256) {
        if (!isListed[asset]) revert AssetNotListed(asset);
        if (price == 0) revert ZeroPrice();
        uint256 assetUnit = 10 ** MockAssetToken(asset).decimals();
        return (usdcIn * assetUnit * 10 ** PRICE_DECIMALS) / (price * 10 ** usdc.decimals());
    }

    /// @notice Mock USDC that `assetIn` asset tokens sell for at `price`, rounded down
    function quoteSell(address asset, uint256 assetIn, uint256 price) public view returns (uint256) {
        if (!isListed[asset]) revert AssetNotListed(asset);
        if (price == 0) revert ZeroPrice();
        uint256 assetUnit = 10 ** MockAssetToken(asset).decimals();
        return (assetIn * price * 10 ** usdc.decimals()) / (assetUnit * 10 ** PRICE_DECIMALS);
    }

    /// @inheritdoc IMockDEX
    /// @dev The caller approves this DEX for `quoteIn` mock USDC first.
    function buy(address asset, uint256 quoteIn, uint256 price) external returns (uint256 assetOut) {
        if (quoteIn == 0) revert ZeroAmount();
        assetOut = quoteBuy(asset, quoteIn, price);
        if (assetOut == 0) revert ZeroOutput();
        if (!usdc.transferFrom(msg.sender, address(this), quoteIn)) revert TransferFailed();
        MockAssetToken(asset).mint(msg.sender, assetOut);
        emit Bought(msg.sender, asset, quoteIn, assetOut, price);
    }

    /// @inheritdoc IMockDEX
    /// @dev The caller approves this DEX for `assetIn` of `asset` first.
    function sell(address asset, uint256 assetIn, uint256 price) external returns (uint256 quoteOut) {
        if (assetIn == 0) revert ZeroAmount();
        quoteOut = quoteSell(asset, assetIn, price);
        if (quoteOut == 0) revert ZeroOutput();
        if (!MockAssetToken(asset).transferFrom(msg.sender, address(this), assetIn)) revert TransferFailed();
        MockAssetToken(asset).burn(address(this), assetIn);
        usdc.mint(msg.sender, quoteOut);
        emit Sold(msg.sender, asset, assetIn, quoteOut, price);
    }
}
