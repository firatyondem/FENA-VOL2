// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAssetToken} from "./MockAssetToken.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @title Mock DEX that swaps at the price the vault verified
/// @notice There is no pool and no slippage. A buy takes mock USDC and mints the asset token at exactly `price`, a sell
/// burns the asset token and pays mock USDC at exactly `price`. The DEX trusts the price it is given, so only traders
/// that the owner approves, which is the vault, may call it. The vault checks every signed price before it gets here.
/// @dev Prices are USD per whole asset token with 18 decimals, as ProjectedJson.readUint(data, "price", 18) reads them.
contract MockDEX {
    uint8 public constant PRICE_DECIMALS = 18;

    MockUSDC public immutable usdc;
    address public immutable owner;

    mapping(address trader => bool) public isTrader;
    mapping(address asset => bool) public isListed;
    address[] private _listedAssets;

    event TraderSet(address indexed trader, bool allowed);
    event AssetListed(address indexed asset, string symbol);
    event Bought(address indexed trader, address indexed asset, uint256 usdcIn, uint256 assetOut, uint256 price);
    event Sold(address indexed trader, address indexed asset, uint256 assetIn, uint256 usdcOut, uint256 price);

    error NotOwner(address caller);
    error NotTrader(address caller);
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

    modifier onlyTrader() {
        if (!isTrader[msg.sender]) revert NotTrader(msg.sender);
        _;
    }

    /// @notice Lets `trader` swap at a price it supplies. Give this only to a contract that verifies its prices.
    function setTrader(address trader, bool allowed) external onlyOwner {
        if (trader == address(0)) revert ZeroAddress();
        isTrader[trader] = allowed;
        emit TraderSet(trader, allowed);
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

    /// @notice Buys `asset` with `usdcIn` mock USDC of the caller at exactly `price`
    /// @dev The caller approves this DEX for `usdcIn` mock USDC first.
    function buy(address asset, uint256 usdcIn, uint256 price) external onlyTrader returns (uint256 assetOut) {
        if (usdcIn == 0) revert ZeroAmount();
        assetOut = quoteBuy(asset, usdcIn, price);
        if (assetOut == 0) revert ZeroOutput();
        if (!usdc.transferFrom(msg.sender, address(this), usdcIn)) revert TransferFailed();
        MockAssetToken(asset).mint(msg.sender, assetOut);
        emit Bought(msg.sender, asset, usdcIn, assetOut, price);
    }

    /// @notice Mock USDC that `assetIn` asset tokens sell for at `price`, rounded down
    function quoteSell(address asset, uint256 assetIn, uint256 price) public view returns (uint256) {
        if (!isListed[asset]) revert AssetNotListed(asset);
        if (price == 0) revert ZeroPrice();
        uint256 assetUnit = 10 ** MockAssetToken(asset).decimals();
        return (assetIn * price * 10 ** usdc.decimals()) / (assetUnit * 10 ** PRICE_DECIMALS);
    }

    /// @notice Sells `assetIn` of the caller's `asset` at exactly `price` for mock USDC
    /// @dev Burns from the caller, so no approval is needed. When the price rose since the buy, the DEX holds less USDC
    /// than it owes and mints the difference, which a mock token allows.
    function sell(address asset, uint256 assetIn, uint256 price) external onlyTrader returns (uint256 usdcOut) {
        if (assetIn == 0) revert ZeroAmount();
        usdcOut = quoteSell(asset, assetIn, price);
        if (usdcOut == 0) revert ZeroOutput();
        MockAssetToken(asset).burn(msg.sender, assetIn);
        uint256 reserve = usdc.balanceOf(address(this));
        if (reserve < usdcOut) usdc.mint(address(this), usdcOut - reserve);
        if (!usdc.transfer(msg.sender, usdcOut)) revert TransferFailed();
        emit Sold(msg.sender, asset, assetIn, usdcOut, price);
    }
}
