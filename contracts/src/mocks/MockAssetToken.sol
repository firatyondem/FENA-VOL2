// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @title Mock asset token that the vault buys, such as tOIL, tDOGE or tETH
/// @notice Only the minter, which is the mock DEX, creates or destroys supply. The DEX mints on a buy at the verified
/// price and burns on a sell, so the token stands in for the real asset without any liquidity behind it.
contract MockAssetToken is MockERC20 {
    address public immutable minter;

    error NotMinter(address caller);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address minter_)
        MockERC20(name_, symbol_, decimals_)
    {
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /// @dev The DEX burns from the account that sells to it, so a sell needs no approval of the asset token.
    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }
}
