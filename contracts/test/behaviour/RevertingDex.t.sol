// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {BehaviourBase} from "./BehaviourBase.sol";
import {SwitchableDEX} from "./mocks/SwitchableDEX.sol";

/// @notice A DEX that is down: the trigger or position stays open, no funds move, and a retry works once it is back
contract RevertingDexTest is BehaviourBase {
    SwitchableDEX switchable;

    function setUp() public override {
        super.setUp();
        switchable = new SwitchableDEX(dex);
        deployVaultOn(address(switchable));
    }

    function test_RevertWhen_TheDexRevertsOnABuy() public {
        (uint256 triggerId, IVault.SignedResponse memory p1) = openAndWait();
        switchable.setDown(true, false);
        Books memory before = books();
        uint256 dexQuote = usdc.balanceOf(address(dex));

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SwitchableDEX.DexDown.selector));
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(usdc.balanceOf(address(dex)), dexQuote, "quote tokens in the real DEX");
        assertEq(usdc.balanceOf(address(switchable)), 0, "quote tokens in the switchable DEX");
        assertEq(usdc.allowance(address(vault), address(switchable)), 0, "allowance left to the DEX");
    }

    function test_ConfirmTrigger_RetriesWithTheSamePriceOnceTheDexIsBack() public {
        (uint256 triggerId, IVault.SignedResponse memory p1) = openAndWait();
        switchable.setDown(true, false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SwitchableDEX.DexDown.selector));
        vault.confirmTrigger(triggerId, p1);

        switchable.setDown(false, false);
        Books memory before = books();
        uint256 expectedOut = dex.quoteBuy(address(teth), 50e6, 2070e18);
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, p1);

        assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
        assertEq(vault.getPosition(positionId).amount, expectedOut, "position amount");
        before.vaultQuote -= 50e6;
        before.vaultAsset += expectedOut;
        before.userBalance -= 50e6;
        before.spentToday += 50e6;
        before.positionCount += 1;
        assertBooks(books(), before);
    }

    function test_ConfirmTrigger_RetriesWithALaterPriceOnceTheDexIsBack() public {
        (uint256 triggerId, IVault.SignedResponse memory p1) = openAndWait();
        switchable.setDown(true, false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SwitchableDEX.DexDown.selector));
        vault.confirmTrigger(triggerId, p1);

        // The DEX is back 20 minutes later, still inside the 4 h window
        vm.warp(block.timestamp + 20 minutes);
        switchable.setDown(false, false);
        IVault.SignedResponse memory laterP1 = signedPrice("2080");
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, laterP1);

        assertEq(vault.getPosition(positionId).entryPrice, 2080e18, "entry price");
        assertEq(vault.getPosition(positionId).amount, dex.quoteBuy(address(teth), 50e6, 2080e18), "amount");
        assertEq(vault.balanceOf(user), 950e6, "user's balance");
        assertEq(vault.spentToday(user, ETH), 50e6, "spent today");
    }

    function test_RevertWhen_TheDexRevertsOnAManualSell() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2100");
        switchable.setDown(false, true);
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(SwitchableDEX.DexDown.selector));
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
        assertEq(teth.balanceOf(address(switchable)), 0, "asset tokens in the switchable DEX");
    }

    function test_Sell_RetriesOnceTheDexIsBack() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2100");
        switchable.setDown(false, true);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(SwitchableDEX.DexDown.selector));
        vault.sell(positionId, IVault.SellReason.Manual, price);

        switchable.setDown(false, false);
        uint256 amount = vault.getPosition(positionId).amount;
        uint256 expectedOut = dex.quoteSell(address(teth), amount, 2100e18);
        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        assertEq(quoteOut, expectedOut, "quote out");
        assertPositionOpen(positionId, false);
        assertEq(vault.balanceOf(user), 950e6 + expectedOut, "user's balance");
        assertEq(teth.balanceOf(address(vault)), 0, "asset tokens in the vault");
        assertEq(usdc.balanceOf(address(vault)), 950e6 + expectedOut, "quote tokens in the vault");
    }

    function test_RevertWhen_TheDexRevertsOnATakeProfitSell() public {
        uint256 positionId = buyEth();
        // Entry 2070 + 8% = 2235.6
        IVault.SignedResponse memory price = signedPrice("2240");
        switchable.setDown(false, true);
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SwitchableDEX.DexDown.selector));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertBooks(books(), before);
        assertPositionOpen(positionId, true);

        switchable.setDown(false, false);
        vm.prank(keeper);
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertPositionOpen(positionId, false);
    }
}

/// @notice The real MockDEX refusing a swap: the vault reverts with the DEX's own error and nothing moves
contract RealDexRefusalTest is BehaviourBase {
    function test_RevertWhen_TheDexHasNotListedTheToken() public {
        uint256 triggerId = openEthTrigger("2000");
        MockAssetToken unlisted = new MockAssetToken("Unlisted Ether", "uETH", 18, address(dex));
        IVault.AssetProfile memory profile = ethProfile();
        profile.token = address(unlisted);
        vault.setAssetProfile(ETH, profile);
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2070");
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockDEX.AssetNotListed.selector, address(unlisted)));
        vault.confirmTrigger(triggerId, p1);
        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);

        // Once the DEX lists the token, the same P1 confirms the trigger.
        dex.listAsset(unlisted);
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, p1);
        assertEq(unlisted.balanceOf(address(vault)), vault.getPosition(positionId).amount, "bought tokens");
    }

    function test_RevertWhen_TheBuyRoundsDownToZero() public {
        // At 1e20 USD per token, 50 USDC buys less than one unit of an 18-decimal token.
        uint256 triggerId = openEthTrigger("100000000000000000000");
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("103500000000000000000");
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroOutput.selector));
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
    }
}
