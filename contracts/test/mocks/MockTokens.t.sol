// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockTestBase} from "./utils/MockTestBase.sol";

contract MockTokensTest is MockTestBase {
    MockUSDC internal usdc;
    MockAssetToken internal oil;

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant MINTER = address(0xD3C);

    function setUp() public {
        usdc = new MockUSDC();
        oil = new MockAssetToken("Test Crude Oil", "tOIL", 18, MINTER);
    }

    function test_usdcHasSixDecimals() public view {
        assertEq(usdc.decimals(), 6, "decimals");
        assertEq(oil.decimals(), 18, "asset decimals");
    }

    function test_anyoneCanMintUsdcUpToTheCap() public {
        vm.prank(ALICE);
        usdc.mint(ALICE, usdc.MAX_MINT());
        assertEq(usdc.balanceOf(ALICE), 1_000_000e6, "balance");
        assertEq(usdc.totalSupply(), 1_000_000e6, "supply");
    }

    function test_usdcMintAboveTheCapReverts() public {
        uint256 tooMuch = usdc.MAX_MINT() + 1;
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.MintTooLarge.selector, tooMuch, usdc.MAX_MINT()));
        usdc.mint(ALICE, tooMuch);
    }

    function test_transferMovesBalance() public {
        usdc.mint(ALICE, 100e6);
        vm.prank(ALICE);
        assertTrue(usdc.transfer(BOB, 40e6), "transfer returned false");
        assertEq(usdc.balanceOf(ALICE), 60e6, "alice");
        assertEq(usdc.balanceOf(BOB), 40e6, "bob");
    }

    function test_transferMoreThanBalanceReverts() public {
        usdc.mint(ALICE, 1e6);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientBalance.selector, ALICE, 1e6, 2e6));
        vm.prank(ALICE);
        usdc.transfer(BOB, 2e6);
    }

    function test_transferToZeroAddressReverts() public {
        usdc.mint(ALICE, 1e6);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.ZeroAddress.selector));
        vm.prank(ALICE);
        usdc.transfer(address(0), 1e6);
    }

    function test_transferFromSpendsAllowance() public {
        usdc.mint(ALICE, 100e6);
        vm.prank(ALICE);
        usdc.approve(BOB, 30e6);
        vm.prank(BOB);
        usdc.transferFrom(ALICE, BOB, 20e6);
        assertEq(usdc.allowance(ALICE, BOB), 10e6, "allowance left");
        assertEq(usdc.balanceOf(BOB), 20e6, "bob");
    }

    function test_transferFromAboveAllowanceReverts() public {
        usdc.mint(ALICE, 100e6);
        vm.prank(ALICE);
        usdc.approve(BOB, 5e6);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector, BOB, 5e6, 6e6));
        vm.prank(BOB);
        usdc.transferFrom(ALICE, BOB, 6e6);
    }

    function test_infiniteAllowanceIsNotSpent() public {
        usdc.mint(ALICE, 100e6);
        vm.prank(ALICE);
        usdc.approve(BOB, type(uint256).max);
        vm.prank(BOB);
        usdc.transferFrom(ALICE, BOB, 100e6);
        assertEq(usdc.allowance(ALICE, BOB), type(uint256).max, "allowance");
    }

    function test_onlyMinterMintsAndBurnsAssets() public {
        vm.prank(MINTER);
        oil.mint(ALICE, 5e18);
        vm.prank(MINTER);
        oil.burn(ALICE, 2e18);
        assertEq(oil.balanceOf(ALICE), 3e18, "balance");
        assertEq(oil.totalSupply(), 3e18, "supply");
    }

    function test_assetMintByOthersReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MockAssetToken.NotMinter.selector, ALICE));
        vm.prank(ALICE);
        oil.mint(ALICE, 1e18);
    }

    function test_assetBurnByOthersReverts() public {
        vm.prank(MINTER);
        oil.mint(ALICE, 1e18);
        vm.expectRevert(abi.encodeWithSelector(MockAssetToken.NotMinter.selector, ALICE));
        vm.prank(ALICE);
        oil.burn(ALICE, 1e18);
    }

    function test_assetNeedsAMinter() public {
        vm.expectRevert(abi.encodeWithSelector(MockERC20.ZeroAddress.selector));
        new MockAssetToken("Test Crude Oil", "tOIL", 18, address(0));
    }

    function testFuzz_mintThenTransferKeepsSupply(uint256 amount, uint256 sent) public {
        amount = bound(amount, 0, usdc.MAX_MINT());
        sent = bound(sent, 0, amount);
        usdc.mint(ALICE, amount);
        vm.prank(ALICE);
        usdc.transfer(BOB, sent);
        assertEq(usdc.balanceOf(ALICE) + usdc.balanceOf(BOB), usdc.totalSupply(), "supply");
    }
}
