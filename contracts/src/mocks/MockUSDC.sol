// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @title Mock USDC that the vault holds and the mock DEX pays out
/// @notice Six decimals like the real USDC. Anyone can mint, so it doubles as the testnet faucet and lets the mock DEX
/// cover a sell that pays out more than it took in. It is worth nothing.
contract MockUSDC is MockERC20 {
    /// @notice Largest amount one call can mint: one million USDC, enough for any demo
    uint256 public constant MAX_MINT = 1_000_000e6;

    error MintTooLarge(uint256 amount, uint256 max);

    constructor() MockERC20("Mock USD Coin", "mUSDC", 6) {}

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount, MAX_MINT);
        _mint(to, amount);
    }
}
