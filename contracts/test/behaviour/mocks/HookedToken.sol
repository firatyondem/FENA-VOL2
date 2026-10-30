// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MintableToken} from "./MintableToken.sol";
import {Reenterer} from "./Reenterer.sol";

/// @notice An ERC-20 that calls back into the vault from inside mint, transfer, transferFrom or approve, after it has
/// booked the call
/// @dev As an asset token the real MockDEX mints it on a buy and pulls it on a sell; as a quote token the DEX pulls it on
/// a buy and mints it on a sell. Either way the callback runs while the vault is in the middle of a swap.
contract HookedToken is MintableToken, Reenterer {
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address minter_)
        MintableToken(name_, symbol_, decimals_, minter_)
    {}

    function mint(address to, uint256 amount) external {
        _checkMinter();
        _mint(to, amount);
        _reenter(this.mint.selector);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        _reenter(this.transfer.selector);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _move(from, to, amount);
        _reenter(this.transferFrom.selector);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        _reenter(this.approve.selector);
        return true;
    }
}
