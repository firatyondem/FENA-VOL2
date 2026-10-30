// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {BehaviourBase} from "./BehaviourBase.sol";

/// @notice The admin changes an asset's token while a position is open: the position still sells the token that its buy
/// bought, and a later buy gets the new token
contract AdminTokenChangeTest is BehaviourBase {
    MockAssetToken other;

    function setUp() public override {
        super.setUp();
        other = new MockAssetToken("Other Ether", "oETH", 18, address(dex));
        dex.listAsset(other);
    }

    /// @dev The admin points ETH at `other`, the way a redeployed mock token would
    function swapEthToken() internal {
        IVault.AssetProfile memory profile = ethProfile();
        profile.token = address(other);
        vault.setAssetProfile(ETH, profile);
    }

    function test_Sell_SellsTheTokenTheBuyBoughtAfterTheAdminChangesTheAssetsToken() public {
        uint256 positionId = buyEth();
        uint256 amount = vault.getPosition(positionId).amount;
        assertEq(teth.balanceOf(address(vault)), amount, "bought tETH");

        swapEthToken();
        vm.warp(block.timestamp + 10 minutes);
        IVault.SignedResponse memory price = signedPrice("2100");
        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        assertEq(quoteOut, dex.quoteSell(address(teth), amount, 2100e18), "proceeds of the bought token");
        assertPositionOpen(positionId, false);
        assertEq(teth.balanceOf(address(vault)), 0, "the bought token was sold");
        assertEq(teth.totalSupply(), 0, "and burned by the DEX");
        assertEq(other.totalSupply(), 0, "the new token was never touched");
        assertEq(vault.balanceOf(user), 1_000e6 - 50e6 + quoteOut, "balance");
    }

    function test_Confirm_BuysTheNewTokenWhileTheOldPositionKeepsTheOldOne() public {
        setEthRuleWithoutCooldown();
        uint256 firstPosition = buyEth();
        uint256 firstAmount = vault.getPosition(firstPosition).amount;

        swapEthToken();
        uint256 secondPosition = buyEth();
        uint256 secondAmount = vault.getPosition(secondPosition).amount;
        assertEq(teth.balanceOf(address(vault)), firstAmount, "the first position holds tETH");
        assertEq(other.balanceOf(address(vault)), secondAmount, "the second position holds oETH");

        // Each position sells its own token.
        vm.warp(block.timestamp + 10 minutes);
        IVault.SignedResponse memory price = signedPrice("2100");
        vm.startPrank(user);
        vault.sell(firstPosition, IVault.SellReason.Manual, price);
        assertEq(teth.balanceOf(address(vault)), 0, "the first sell took the tETH");
        assertEq(other.balanceOf(address(vault)), secondAmount, "and left the oETH");
        vault.sell(secondPosition, IVault.SellReason.Manual, price);
        vm.stopPrank();

        assertEq(other.balanceOf(address(vault)), 0, "the second sell took the oETH");
        assertEq(usdc.balanceOf(address(vault)), vault.balanceOf(user), "the vault holds exactly the balance");
    }
}
