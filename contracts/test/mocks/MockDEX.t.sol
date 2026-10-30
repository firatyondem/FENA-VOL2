// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockTestBase} from "./utils/MockTestBase.sol";

contract MockDEXTest is MockTestBase {
    MockUSDC internal usdc;
    MockDEX internal dex;
    MockAssetToken internal eth;
    MockAssetToken internal doge;

    address internal constant OWNER = address(0x0E);
    address internal constant VAULT = address(0x7A017);
    address internal constant STRANGER = address(0xBAD);

    // 2244.695 USD, as Nodary signed it and ProjectedJson reads it with 18 decimals
    uint256 internal constant ETH_PRICE = 2244.695e18;

    event Bought(address indexed trader, address indexed asset, uint256 usdcIn, uint256 assetOut, uint256 price);
    event Sold(address indexed trader, address indexed asset, uint256 assetIn, uint256 usdcOut, uint256 price);

    function setUp() public {
        usdc = new MockUSDC();
        dex = new MockDEX(usdc, OWNER);
        eth = new MockAssetToken("Test Ether", "tETH", 18, address(dex));
        doge = new MockAssetToken("Test Dogecoin", "tDOGE", 18, address(dex));
        vm.prank(OWNER);
        dex.listAsset(eth);
        vm.prank(OWNER);
        dex.setTrader(VAULT, true);

        usdc.mint(VAULT, 100_000e6);
        vm.prank(VAULT);
        usdc.approve(address(dex), type(uint256).max);
    }

    // Listing and access control

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroAddress.selector));
        new MockDEX(MockUSDC(address(0)), OWNER);
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroAddress.selector));
        new MockDEX(usdc, address(0));
    }

    function test_ownerListsAssets() public {
        vm.prank(OWNER);
        dex.listAsset(doge);
        assertTrue(dex.isListed(address(doge)), "doge listed");
        address[] memory listed = dex.listedAssets();
        assertEq(listed.length, 2, "listed count");
        assertEq(listed[1], address(doge), "second asset");
    }

    function test_listingByStrangerReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.NotOwner.selector, STRANGER));
        vm.prank(STRANGER);
        dex.listAsset(doge);
    }

    function test_listingTwiceReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.AssetAlreadyListed.selector, address(eth)));
        vm.prank(OWNER);
        dex.listAsset(eth);
    }

    function test_listingATokenTheDexCannotMintReverts() public {
        MockAssetToken foreign = new MockAssetToken("Foreign", "FRN", 18, STRANGER);
        vm.expectRevert(abi.encodeWithSelector(MockDEX.DexIsNotMinter.selector, address(foreign)));
        vm.prank(OWNER);
        dex.listAsset(foreign);
    }

    function test_settingTradersIsOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.NotOwner.selector, STRANGER));
        vm.prank(STRANGER);
        dex.setTrader(STRANGER, true);

        vm.prank(OWNER);
        dex.setTrader(VAULT, false);
        assertTrue(!dex.isTrader(VAULT), "vault removed");
    }

    function test_buyByNonTraderReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.NotTrader.selector, STRANGER));
        vm.prank(STRANGER);
        dex.buy(address(eth), 1_000e6, ETH_PRICE);
    }

    function test_sellByNonTraderReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.NotTrader.selector, STRANGER));
        vm.prank(STRANGER);
        dex.sell(address(eth), 1e18, ETH_PRICE);
    }

    // Buying

    function test_buyMintsAtExactlyThePrice() public {
        vm.prank(VAULT);
        uint256 assetOut = dex.buy(address(eth), 2_000e6, 2_000e18);
        assertEq(assetOut, 1e18, "one ETH for 2000 USDC at 2000");
        assertEq(eth.balanceOf(VAULT), 1e18, "vault ETH");
        assertEq(usdc.balanceOf(VAULT), 98_000e6, "vault USDC");
        assertEq(usdc.balanceOf(address(dex)), 2_000e6, "dex reserve");
    }

    function test_buyAtAFractionalSignedPrice() public {
        vm.prank(VAULT);
        uint256 assetOut = dex.buy(address(eth), 1_000e6, ETH_PRICE);
        // 1000 / 2244.695 = 0.445494822236428557...; rounded down to wei (checked with exact fractions)
        assertEq(assetOut, (1_000e6 * 1e18 * 1e18) / (ETH_PRICE * 1e6), "asset out");
        assertEq(assetOut, 445494822236428557, "asset out literal");
    }

    function test_buyEmitsBought() public {
        uint256 expectedOut = dex.quoteBuy(address(eth), 500e6, ETH_PRICE);
        vm.expectEmit(true, true, false, true);
        emit Bought(VAULT, address(eth), 500e6, expectedOut, ETH_PRICE);
        vm.prank(VAULT);
        dex.buy(address(eth), 500e6, ETH_PRICE);
    }

    function test_buyRejectsUnlistedAsset() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.AssetNotListed.selector, address(doge)));
        vm.prank(VAULT);
        dex.buy(address(doge), 1_000e6, 1e17);
    }

    function test_buyRejectsZeroAmountAndPrice() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroAmount.selector));
        vm.prank(VAULT);
        dex.buy(address(eth), 0, ETH_PRICE);

        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroPrice.selector));
        vm.prank(VAULT);
        dex.buy(address(eth), 1_000e6, 0);
    }

    function test_buyRejectsDustThatRoundsToZero() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroOutput.selector));
        vm.prank(VAULT);
        dex.buy(address(eth), 1, type(uint128).max);
    }

    function test_buyWithoutApprovalReverts() public {
        address otherVault = address(0x7A018);
        vm.prank(OWNER);
        dex.setTrader(otherVault, true);
        usdc.mint(otherVault, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector, address(dex), 0, 1_000e6));
        vm.prank(otherVault);
        dex.buy(address(eth), 1_000e6, ETH_PRICE);
    }

    // Selling

    function test_sellPaysAtExactlyThePrice() public {
        vm.prank(VAULT);
        dex.buy(address(eth), 2_000e6, 2_000e18);
        vm.prank(VAULT);
        uint256 usdcOut = dex.sell(address(eth), 1e18, 2_000e18);
        assertEq(usdcOut, 2_000e6, "usdc out");
        assertEq(eth.balanceOf(VAULT), 0, "ETH burned");
        assertEq(eth.totalSupply(), 0, "supply");
        assertEq(usdc.balanceOf(VAULT), 100_000e6, "vault back to start");
    }

    function test_sellAfterARiseMintsTheShortfall() public {
        vm.prank(VAULT);
        dex.buy(address(eth), 2_000e6, 2_000e18);
        // Take profit at +8%
        vm.prank(VAULT);
        uint256 usdcOut = dex.sell(address(eth), 1e18, 2_160e18);
        assertEq(usdcOut, 2_160e6, "usdc out");
        assertEq(usdc.balanceOf(VAULT), 100_160e6, "vault profit");
        assertEq(usdc.balanceOf(address(dex)), 0, "dex reserve spent");
    }

    function test_sellAfterADropKeepsTheRestInReserve() public {
        vm.prank(VAULT);
        dex.buy(address(eth), 2_000e6, 2_000e18);
        // Stop loss at -5%
        vm.prank(VAULT);
        uint256 usdcOut = dex.sell(address(eth), 1e18, 1_900e18);
        assertEq(usdcOut, 1_900e6, "usdc out");
        assertEq(usdc.balanceOf(address(dex)), 100e6, "dex keeps the difference");
    }

    function test_sellEmitsSold() public {
        vm.prank(VAULT);
        uint256 bought = dex.buy(address(eth), 1_000e6, ETH_PRICE);
        uint256 expectedOut = dex.quoteSell(address(eth), bought, ETH_PRICE);
        vm.expectEmit(true, true, false, true);
        emit Sold(VAULT, address(eth), bought, expectedOut, ETH_PRICE);
        vm.prank(VAULT);
        dex.sell(address(eth), bought, ETH_PRICE);
    }

    function test_sellMoreThanHeldReverts() public {
        vm.prank(VAULT);
        dex.buy(address(eth), 2_000e6, 2_000e18);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.InsufficientBalance.selector, VAULT, 1e18, 2e18));
        vm.prank(VAULT);
        dex.sell(address(eth), 2e18, 2_000e18);
    }

    function test_sellRejectsZeroAmountAndPrice() public {
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroAmount.selector));
        vm.prank(VAULT);
        dex.sell(address(eth), 0, ETH_PRICE);

        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroPrice.selector));
        vm.prank(VAULT);
        dex.sell(address(eth), 1e18, 0);
    }

    // Properties

    /// A round trip at one price never pays out more than went in, and loses at most rounding dust
    function testFuzz_roundTripAtOnePriceLosesOnlyDust(uint256 usdcIn, uint256 price) public {
        usdcIn = bound(usdcIn, 1e6, 100_000e6);
        price = bound(price, 1e15, 1_000_000e18);
        vm.prank(VAULT);
        uint256 assetOut = dex.buy(address(eth), usdcIn, price);
        vm.prank(VAULT);
        uint256 usdcOut = dex.sell(address(eth), assetOut, price);
        assertLe(usdcOut, usdcIn, "round trip profit");
        assertGe(usdcOut + 1, usdcIn, "more than dust lost");
    }

    /// A higher price buys fewer asset tokens for the same USDC
    function testFuzz_quoteBuyFallsAsPriceRises(uint256 usdcIn, uint256 price, uint256 rise) public view {
        usdcIn = bound(usdcIn, 1e6, 100_000e6);
        price = bound(price, 1e15, 1_000_000e18);
        rise = bound(rise, 1, price);
        assertLe(dex.quoteBuy(address(eth), usdcIn, price + rise), dex.quoteBuy(address(eth), usdcIn, price), "quote");
    }
}
