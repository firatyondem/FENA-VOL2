// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @title Mock USDC that the vault holds and the mock DEX pays out
/// @notice Six decimals like the real USDC. Anyone can mint, so it doubles as the testnet faucet, and the mock DEX mints
/// what a sell pays, as IMockDEX requires of the quote token. It is worth nothing.
contract MockUSDC is MockERC20 {
    constructor() MockERC20("Mock USD Coin", "mUSDC", 6) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
