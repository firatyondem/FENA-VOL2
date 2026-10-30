// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IMockDEX} from "../../src/interfaces/IMockDEX.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";

contract MockDEXTest is Test {
    MockUSDC internal usdc;
    MockDEX internal dex;
    MockAssetToken internal eth;
    MockAssetToken internal doge;

    address internal owner = makeAddr("owner");
    address internal trader = makeAddr("trader");
    address internal stranger = makeAddr("stranger");

    // 2244.695 USD, as Nodary signed it and ProjectedJson reads it with 18 decimals
    uint256 internal constant ETH_PRICE = 2244.695e18;

    event Bought(address indexed trader, address indexed asset, uint256 usdcIn, uint256 assetOut, uint256 price);
    event Sold(address indexed trader, address indexed asset, uint256 assetIn, uint256 usdcOut, uint256 price);

    function setUp() public {
        usdc = new MockUSDC();
        dex = new MockDEX(usdc, owner);
        eth = new MockAssetToken("Test Ether", "tETH", 18, address(dex));
        doge = new MockAssetToken("Test Dogecoin", "tDOGE", 18, address(dex));
        vm.prank(owner);
        dex.listAsset(eth);

        usdc.mint(trader, 100_000e6);
        vm.startPrank(trader);
        usdc.approve(address(dex), type(uint256).max);
        eth.approve(address(dex), type(uint256).max);
        vm.stopPrank();
    }

    function buy(uint256 usdcIn, uint256 price) internal returns (uint256) {
        vm.prank(trader);
        return dex.buy(address(eth), usdcIn, price);
    }

    function sell(uint256 assetIn, uint256 price) internal returns (uint256) {
        vm.prank(trader);
        return dex.sell(address(eth), assetIn, price);
    }

    // The interface the vault depends on

    function test_ImplementsIMockDEX() public view {
        IMockDEX asInterface = IMockDEX(address(dex));
        assertEq(asInterface.quoteToken(), address(usdc));
    }

    // Listing

    function test_RevertWhen_ConstructedWithZeroAddresses() public {
        vm.expectRevert(MockDEX.ZeroAddress.selector);
        new MockDEX(MockUSDC(address(0)), owner);
        vm.expectRevert(MockDEX.ZeroAddress.selector);
        new MockDEX(usdc, address(0));
    }

    function test_OwnerListsAssets() public {
        vm.prank(owner);
        dex.listAsset(doge);
        assertTrue(dex.isListed(address(doge)));
        assertEq(dex.listedAssets().length, 2);
        assertEq(dex.listedAssets()[1], address(doge));
    }

    function test_RevertWhen_StrangerLists() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.NotOwner.selector, stranger));
        vm.prank(stranger);
        dex.listAsset(doge);
    }

    function test_RevertWhen_ListedTwice() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.AssetAlreadyListed.selector, address(eth)));
        vm.prank(owner);
        dex.listAsset(eth);
    }

    function test_RevertWhen_DexCannotMintTheToken() public {
        MockAssetToken foreign = new MockAssetToken("Foreign", "FRN", 18, stranger);
        vm.expectRevert(abi.encodeWithSelector(MockDEX.DexIsNotMinter.selector, address(foreign)));
        vm.prank(owner);
        dex.listAsset(foreign);
    }

    // Buying

    function test_BuyMintsAtExactlyThePrice() public {
        uint256 assetOut = buy(2_000e6, 2_000e18);
        assertEq(assetOut, 1e18);
        assertEq(eth.balanceOf(trader), 1e18);
        assertEq(usdc.balanceOf(trader), 98_000e6);
        assertEq(usdc.balanceOf(address(dex)), 2_000e6);
    }

    function test_BuyAtAFractionalSignedPrice() public {
        // 1000 / 2244.695 = 0.445494822236428557..., rounded down to wei (checked with exact fractions)
        assertEq(buy(1_000e6, ETH_PRICE), 445494822236428557);
    }

    function test_BuyEmitsBought() public {
        uint256 expected = dex.quoteBuy(address(eth), 500e6, ETH_PRICE);
        vm.expectEmit(true, true, false, true);
        emit Bought(trader, address(eth), 500e6, expected, ETH_PRICE);
        buy(500e6, ETH_PRICE);
    }

    function test_RevertWhen_BuyingAnUnlistedAsset() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.AssetNotListed.selector, address(doge)));
        vm.prank(trader);
        dex.buy(address(doge), 1_000e6, 1e17);
    }

    function test_RevertWhen_BuyingWithZeroAmountOrPrice() public {
        vm.expectRevert(MockDEX.ZeroAmount.selector);
        buy(0, ETH_PRICE);
        vm.expectRevert(MockDEX.ZeroPrice.selector);
        buy(1_000e6, 0);
    }

    function test_RevertWhen_BuyRoundsToZero() public {
        vm.expectRevert(MockDEX.ZeroOutput.selector);
        buy(1, type(uint128).max);
    }

    function test_RevertWhen_BuyerDidNotApprove() public {
        usdc.mint(stranger, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector, address(dex), 0, 1_000e6));
        vm.prank(stranger);
        dex.buy(address(eth), 1_000e6, ETH_PRICE);
    }

    // Selling

    function test_SellPaysAtExactlyThePrice() public {
        buy(2_000e6, 2_000e18);
        assertEq(sell(1e18, 2_000e18), 2_000e6);
        assertEq(eth.balanceOf(trader), 0);
        assertEq(eth.totalSupply(), 0, "the sold tokens are burned");
        assertEq(usdc.balanceOf(trader), 100_000e6);
    }

    function test_SellAfterARiseMintsWhatItPays() public {
        buy(2_000e6, 2_000e18);
        // Take profit at +8%
        assertEq(sell(1e18, 2_160e18), 2_160e6);
        assertEq(usdc.balanceOf(trader), 100_160e6);
    }

    function test_SellEmitsSold() public {
        uint256 bought = buy(1_000e6, ETH_PRICE);
        uint256 expected = dex.quoteSell(address(eth), bought, ETH_PRICE);
        vm.expectEmit(true, true, false, true);
        emit Sold(trader, address(eth), bought, expected, ETH_PRICE);
        sell(bought, ETH_PRICE);
    }

    function test_RevertWhen_SellingMoreThanHeld() public {
        buy(2_000e6, 2_000e18);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientBalance.selector, trader, 1e18, 2e18));
        sell(2e18, 2_000e18);
    }

    function test_RevertWhen_SellerDidNotApprove() public {
        buy(2_000e6, 2_000e18);
        vm.prank(trader);
        eth.approve(address(dex), 0);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector, address(dex), 0, 1e18));
        sell(1e18, 2_000e18);
    }

    function test_RevertWhen_SellingWithZeroAmountOrPrice() public {
        vm.expectRevert(MockDEX.ZeroAmount.selector);
        sell(0, ETH_PRICE);
        vm.expectRevert(MockDEX.ZeroPrice.selector);
        sell(1e18, 0);
    }

    // Properties

    /// A round trip at one price never pays out more than went in, and loses at most rounding dust
    function testFuzz_RoundTripAtOnePriceLosesOnlyDust(uint256 usdcIn, uint256 price) public {
        usdcIn = bound(usdcIn, 1e6, 100_000e6);
        price = bound(price, 1e15, 1_000_000e18);
        uint256 usdcOut = sell(buy(usdcIn, price), price);
        assertLe(usdcOut, usdcIn);
        assertGe(usdcOut + 1, usdcIn);
    }

    /// A higher price buys fewer asset tokens for the same USDC
    function testFuzz_QuoteBuyFallsAsPriceRises(uint256 usdcIn, uint256 price, uint256 rise) public view {
        usdcIn = bound(usdcIn, 1e6, 100_000e6);
        price = bound(price, 1e15, 1_000_000e18);
        rise = bound(rise, 1, price);
        assertLe(dex.quoteBuy(address(eth), usdcIn, price + rise), dex.quoteBuy(address(eth), usdcIn, price));
    }
}
