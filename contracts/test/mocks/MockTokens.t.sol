// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";

contract MockTokensTest is Test {
    MockUSDC internal usdc;
    MockAssetToken internal oil;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal minter = makeAddr("minter");

    function setUp() public {
        usdc = new MockUSDC();
        oil = new MockAssetToken("Test Crude Oil", "tOIL", 18, minter);
    }

    function test_Decimals() public view {
        assertEq(usdc.decimals(), 6);
        assertEq(oil.decimals(), 18);
        assertEq(oil.symbol(), "tOIL");
    }

    function test_AnyoneMintsUsdc() public {
        vm.prank(alice);
        usdc.mint(alice, 5_000_000e6);
        assertEq(usdc.balanceOf(alice), 5_000_000e6);
        assertEq(usdc.totalSupply(), 5_000_000e6);
    }

    function test_TransferMovesBalance() public {
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        assertTrue(usdc.transfer(bob, 40e6));
        assertEq(usdc.balanceOf(alice), 60e6);
        assertEq(usdc.balanceOf(bob), 40e6);
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        usdc.mint(alice, 1e6);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientBalance.selector, alice, 1e6, 2e6));
        vm.prank(alice);
        usdc.transfer(bob, 2e6);
    }

    function test_RevertWhen_TransferToZeroAddress() public {
        usdc.mint(alice, 1e6);
        vm.expectRevert(MockERC20.ZeroAddress.selector);
        vm.prank(alice);
        usdc.transfer(address(0), 1e6);
    }

    function test_TransferFromSpendsAllowance() public {
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(bob, 30e6);
        vm.prank(bob);
        usdc.transferFrom(alice, bob, 20e6);
        assertEq(usdc.allowance(alice, bob), 10e6);
        assertEq(usdc.balanceOf(bob), 20e6);
    }

    function test_RevertWhen_TransferFromExceedsAllowance() public {
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(bob, 5e6);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector, bob, 5e6, 6e6));
        vm.prank(bob);
        usdc.transferFrom(alice, bob, 6e6);
    }

    function test_InfiniteAllowanceIsNotSpent() public {
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(bob, type(uint256).max);
        vm.prank(bob);
        usdc.transferFrom(alice, bob, 100e6);
        assertEq(usdc.allowance(alice, bob), type(uint256).max);
    }

    function test_OnlyMinterMintsAndBurnsAssets() public {
        vm.prank(minter);
        oil.mint(alice, 5e18);
        vm.prank(minter);
        oil.burn(alice, 2e18);
        assertEq(oil.balanceOf(alice), 3e18);
        assertEq(oil.totalSupply(), 3e18);
    }

    function test_RevertWhen_OthersMintAssets() public {
        vm.expectRevert(abi.encodeWithSelector(MockAssetToken.NotMinter.selector, alice));
        vm.prank(alice);
        oil.mint(alice, 1e18);
    }

    function test_RevertWhen_OthersBurnAssets() public {
        vm.prank(minter);
        oil.mint(alice, 1e18);
        vm.expectRevert(abi.encodeWithSelector(MockAssetToken.NotMinter.selector, alice));
        vm.prank(alice);
        oil.burn(alice, 1e18);
    }

    function test_RevertWhen_AssetHasNoMinter() public {
        vm.expectRevert(MockERC20.ZeroAddress.selector);
        new MockAssetToken("Test Crude Oil", "tOIL", 18, address(0));
    }

    function testFuzz_TransfersKeepSupply(uint256 amount, uint256 sent) public {
        amount = bound(amount, 0, 1e30);
        sent = bound(sent, 0, amount);
        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.transfer(bob, sent);
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob), usdc.totalSupply());
    }
}
