// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Storage and bookkeeping that the hostile tokens share; each token writes its own transfer functions
/// @dev With a zero minter anyone can mint, like MockUSDC, so it can stand in as the DEX's quote token. With a minter,
/// only the minter can mint and burn, like MockAssetToken, so the real MockDEX can list it.
abstract contract MintableToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    address public immutable minter;
    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotMinter(address caller);
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address minter_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        minter = minter_;
    }

    function burn(address from, uint256 amount) external {
        _checkMinter();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(from, balance, amount);
        balanceOf[from] = balance - amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _checkMinter() internal view {
        if (minter != address(0) && msg.sender != minter) revert NotMinter(msg.sender);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _approve(address owner, address spender, uint256 amount) internal {
        allowance[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function _spendAllowance(address owner, uint256 amount) internal {
        uint256 allowed = allowance[owner][msg.sender];
        if (allowed < amount) revert InsufficientAllowance(msg.sender, allowed, amount);
        allowance[owner][msg.sender] = allowed - amount;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(from, balance, amount);
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
