// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MintableToken} from "./MintableToken.sol";

/// @notice An ERC-20 that, when switched, answers transfer, transferFrom or approve with false instead of reverting and
/// moves nothing, as some older tokens do
contract FalseReturningToken is MintableToken {
    bool public failsTransfer;
    bool public failsTransferFrom;
    bool public failsApprove;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address minter_)
        MintableToken(name_, symbol_, decimals_, minter_)
    {}

    function setFailures(bool failsTransfer_, bool failsTransferFrom_, bool failsApprove_) external {
        failsTransfer = failsTransfer_;
        failsTransferFrom = failsTransferFrom_;
        failsApprove = failsApprove_;
    }

    function mint(address to, uint256 amount) external {
        _checkMinter();
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failsTransfer) return false;
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failsTransferFrom) return false;
        _spendAllowance(from, amount);
        _move(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (failsApprove) return false;
        _approve(msg.sender, spender, amount);
        return true;
    }
}
