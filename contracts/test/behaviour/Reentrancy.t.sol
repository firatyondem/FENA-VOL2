// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {BehaviourBase, IExecutor} from "./BehaviourBase.sol";
import {HookedToken} from "./mocks/HookedToken.sol";
import {ReentrantDEX} from "./mocks/ReentrantDEX.sol";

/// @notice A DEX that calls back into the vault in the middle of a buy or sell. With the callback's error bubbled up,
/// the whole swap reverts with ReentrancyGuardReentrantCall and nothing moves; with the error swallowed, the swap goes
/// through once and the callback has no effect.
contract ReentrantDexTest is BehaviourBase {
    // The DEX's own balance in the vault, which a re-entered withdraw would take
    uint256 constant STAKE = 100e6;

    ReentrantDEX reentrant;

    function setUp() public override {
        super.setUp();
        reentrant = new ReentrantDEX(dex);
        deployVaultOn(address(reentrant));
        setEthRuleWithoutCooldown();
        fundContract(address(reentrant), STAKE);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // During a buy
    // ---------------------------------------------------------------------------------------------------------------

    function test_RevertWhen_TheDexReentersWithdrawDuringABuy() public {
        (uint256 triggerId, IVault.SignedResponse memory p1) = openAndWait();
        reentrant.arm(ReentrantDEX.buy.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), true);
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(reentrancyError());
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(address(reentrant)), STAKE, "DEX's balance in the vault");
    }

    function test_ConfirmTrigger_IgnoresAWithdrawThatTheDexReenters() public {
        (uint256 triggerId, IVault.SignedResponse memory p1) = openAndWait();
        reentrant.arm(ReentrantDEX.buy.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), false);
        Books memory before = books();
        uint256 expectedOut = dex.quoteBuy(address(teth), 50e6, 2070e18);

        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, p1);

        assertCallbackFailed(reentrant, reentrancyError());
        assertEq(vault.balanceOf(address(reentrant)), STAKE, "DEX's balance in the vault");
        assertEq(usdc.balanceOf(address(reentrant)), 0, "quote tokens the DEX took out");
        assertEq(vault.getPosition(positionId).amount, expectedOut, "position amount");
        before.vaultQuote -= 50e6;
        before.vaultAsset += expectedOut;
        before.userBalance -= 50e6;
        before.spentToday += 50e6;
        before.positionCount += 1;
        assertBooks(books(), before);
    }

    function test_RevertWhen_TheDexReentersConfirmTriggerDuringABuy() public {
        (uint256 first, uint256 second, IVault.SignedResponse memory p1, IVault.SignedResponse memory secondP1) =
            openTwoAndWait();
        reentrant.arm(
            ReentrantDEX.buy.selector, address(vault), abi.encodeCall(IVault.confirmTrigger, (second, secondP1)), true
        );
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(reentrancyError());
        vault.confirmTrigger(first, p1);

        assertBooks(books(), before);
        assertTriggerStatus(first, IVault.TriggerStatus.Open);
        assertTriggerStatus(second, IVault.TriggerStatus.Open);
    }

    function test_ConfirmTrigger_BuysOnceWhenTheDexReentersASecondConfirm() public {
        (uint256 first, uint256 second, IVault.SignedResponse memory p1, IVault.SignedResponse memory secondP1) =
            openTwoAndWait();
        reentrant.arm(
            ReentrantDEX.buy.selector, address(vault), abi.encodeCall(IVault.confirmTrigger, (second, secondP1)), false
        );

        vm.prank(keeper);
        vault.confirmTrigger(first, p1);

        assertCallbackFailed(reentrant, reentrancyError());
        assertTriggerStatus(first, IVault.TriggerStatus.Confirmed);
        assertTriggerStatus(second, IVault.TriggerStatus.Open);
        assertEq(vault.positionCount(), 1, "position count");
        assertEq(vault.spentToday(user, ETH), 50e6, "spent today");
        assertEq(vault.balanceOf(user), 950e6, "user's balance");

        // The callback's P1 was valid: outside the swap it confirms the second trigger.
        vm.prank(keeper);
        vault.confirmTrigger(second, secondP1);
        assertEq(vault.positionCount(), 2, "position count after the second confirm");
    }

    function test_RevertWhen_TheDexReentersATakeProfitSellDuringABuy() public {
        uint256 positionId = buyEth();
        uint256 triggerId = openEthTrigger("2100");
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2180");
        // Entry 2070 + 8% = 2235.6
        IVault.SignedResponse memory takeProfit = signedPrice("2240");
        reentrant.arm(
            ReentrantDEX.buy.selector,
            address(vault),
            abi.encodeCall(IVault.sell, (positionId, IVault.SellReason.TakeProfit, takeProfit)),
            true
        );
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(reentrancyError());
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertPositionOpen(positionId, true);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // During a sell
    // ---------------------------------------------------------------------------------------------------------------

    function test_RevertWhen_TheDexReentersWithdrawDuringASell() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2240");
        reentrant.arm(ReentrantDEX.sell.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), true);
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(reentrancyError());
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
        assertEq(vault.balanceOf(address(reentrant)), STAKE, "DEX's balance in the vault");
    }

    function test_RevertWhen_TheDexReentersTheSameSellDuringASell() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2240");
        reentrant.arm(
            ReentrantDEX.sell.selector,
            address(vault),
            abi.encodeCall(IVault.sell, (positionId, IVault.SellReason.TakeProfit, price)),
            true
        );
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(reentrancyError());
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    function test_Sell_PaysOnceWhenTheDexReentersTheSameSell() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2240");
        reentrant.arm(
            ReentrantDEX.sell.selector,
            address(vault),
            abi.encodeCall(IVault.sell, (positionId, IVault.SellReason.TakeProfit, price)),
            false
        );
        uint256 expectedOut = dex.quoteSell(address(teth), vault.getPosition(positionId).amount, 2240e18);

        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        assertCallbackFailed(reentrant, reentrancyError());
        assertEq(quoteOut, expectedOut, "quote out");
        assertPositionOpen(positionId, false);
        assertEq(vault.balanceOf(user), 950e6 + expectedOut, "user's balance");
        assertEq(teth.balanceOf(address(vault)), 0, "asset tokens in the vault");
        assertEq(usdc.balanceOf(address(vault)), 950e6 + expectedOut + STAKE, "quote tokens in the vault");
    }

    function test_RevertWhen_TheDexReentersConfirmTriggerDuringASell() public {
        uint256 positionId = buyEth();
        uint256 triggerId = openEthTrigger("2100");
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2180");
        IVault.SignedResponse memory price = signedPrice("2181");
        reentrant.arm(
            ReentrantDEX.sell.selector, address(vault), abi.encodeCall(IVault.confirmTrigger, (triggerId, p1)), true
        );
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(reentrancyError());
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
    }

    /// @dev Two triggers from two posts a minute apart (P0 2000 and 2001), and a P1 for each 31 minutes later
    function openTwoAndWait()
        private
        returns (uint256 first, uint256 second, IVault.SignedResponse memory p1, IVault.SignedResponse memory secondP1)
    {
        first = openEthTrigger("2000");
        second = openEthTrigger("2001");
        vm.warp(block.timestamp + 31 minutes);
        p1 = signedPrice("2070");
        secondP1 = signedPrice("2071");
    }
}

/// @notice An asset token that calls back into the vault while the real MockDEX mints it on a buy, or while the vault
/// approves it and the DEX pulls it on a sell
contract ReentrantAssetTokenTest is BehaviourBase {
    uint256 constant STAKE = 100e6;

    HookedToken hooked;

    function setUp() public override {
        super.setUp();
        hooked = new HookedToken("Hooked Ether", "hETH", 18, address(dex));
        dex.listAsset(MockAssetToken(address(hooked)));
        // books() and ethProfile() read `teth`, so the hooked token takes its place as the ETH token.
        teth = MockAssetToken(address(hooked));
        vault.setAssetProfile(ETH, ethProfile());
        setEthRuleWithoutCooldown();
        fundContract(address(hooked), STAKE);
    }

    function test_RevertWhen_TheAssetTokenReentersWithdrawWhileItIsMinted() public {
        (uint256 triggerId, IVault.SignedResponse memory p1) = openAndWait();
        hooked.arm(HookedToken.mint.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), true);
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(reentrancyError());
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(address(hooked)), STAKE, "token's balance in the vault");
    }

    function test_ConfirmTrigger_BuysOnceWhenTheAssetTokenReentersASecondConfirm() public {
        uint256 first = openEthTrigger("2000");
        uint256 second = openEthTrigger("2001");
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2070");
        IVault.SignedResponse memory secondP1 = signedPrice("2071");
        hooked.arm(
            HookedToken.mint.selector, address(vault), abi.encodeCall(IVault.confirmTrigger, (second, secondP1)), false
        );
        uint256 expectedOut = dex.quoteBuy(address(hooked), 50e6, 2070e18);

        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(first, p1);

        assertCallbackFailed(hooked, reentrancyError());
        assertTriggerStatus(second, IVault.TriggerStatus.Open);
        assertEq(vault.positionCount(), 1, "position count");
        assertEq(vault.getPosition(positionId).amount, expectedOut, "position amount");
        assertEq(hooked.balanceOf(address(vault)), expectedOut, "asset tokens in the vault");
        assertEq(vault.spentToday(user, ETH), 50e6, "spent today");
    }

    function test_RevertWhen_TheAssetTokenReentersTheSameSellWhenTheVaultApprovesIt() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2240");
        hooked.arm(
            HookedToken.approve.selector,
            address(vault),
            abi.encodeCall(IVault.sell, (positionId, IVault.SellReason.TakeProfit, price)),
            true
        );
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(reentrancyError());
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    function test_Sell_IgnoresAWithdrawThatTheAssetTokenReentersWhileTheDexPullsIt() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2240");
        hooked.arm(HookedToken.transferFrom.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), false);
        uint256 expectedOut = dex.quoteSell(address(hooked), vault.getPosition(positionId).amount, 2240e18);

        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        assertCallbackFailed(hooked, reentrancyError());
        assertEq(quoteOut, expectedOut, "quote out");
        assertPositionOpen(positionId, false);
        assertEq(vault.balanceOf(address(hooked)), STAKE, "token's balance in the vault");
        assertEq(usdc.balanceOf(address(hooked)), 0, "quote tokens the token took out");
        assertEq(vault.balanceOf(user), 950e6 + expectedOut, "user's balance");
    }
}

/// @notice A quote token that calls back into the vault while the vault pays it out, takes it in, or the real MockDEX
/// pulls or mints it during a swap
contract ReentrantQuoteTokenTest is BehaviourBase {
    uint256 constant STAKE = 100e6;

    HookedToken quote;

    function setUp() public override {
        super.setUp();
        // No minter, so anyone can mint it, like MockUSDC
        quote = new HookedToken("Hooked USD Coin", "hUSDC", 6, address(0));
        deployMarketOn(address(quote));
        setEthRuleWithoutCooldown();
        fundContract(address(quote), STAKE);
    }

    function test_RevertWhen_TheQuoteTokenReentersWithdrawDuringAWithdraw() public {
        // The token withdraws its own balance and asks for it again while the vault pays it.
        quote.arm(HookedToken.transfer.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), true);
        uint256 vaultQuote = quote.balanceOf(address(vault));

        vm.expectRevert(reentrancyError());
        IExecutor(address(quote)).execute(address(vault), abi.encodeCall(IVault.withdraw, (STAKE)));

        assertEq(vault.balanceOf(address(quote)), STAKE, "token's balance in the vault");
        assertEq(quote.balanceOf(address(quote)), 0, "quote tokens the token took out");
        assertEq(quote.balanceOf(address(vault)), vaultQuote, "quote tokens in the vault");
    }

    function test_Withdraw_PaysOnceWhenTheQuoteTokenReentersIt() public {
        // Without the guard, the second withdraw would go through: 40 + 40 is less than the stake.
        quote.arm(HookedToken.transfer.selector, address(vault), abi.encodeCall(IVault.withdraw, (40e6)), false);
        uint256 vaultQuote = quote.balanceOf(address(vault));

        IExecutor(address(quote)).execute(address(vault), abi.encodeCall(IVault.withdraw, (40e6)));

        assertCallbackFailed(quote, reentrancyError());
        assertEq(vault.balanceOf(address(quote)), STAKE - 40e6, "token's balance in the vault");
        assertEq(quote.balanceOf(address(quote)), 40e6, "quote tokens the token took out");
        assertEq(quote.balanceOf(address(vault)), vaultQuote - 40e6, "quote tokens in the vault");
    }

    function test_RevertWhen_TheQuoteTokenReentersWithdrawDuringADeposit() public {
        quote.mint(user, 10e6);
        quote.arm(HookedToken.transferFrom.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), true);
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(reentrancyError());
        vault.deposit(10e6);

        assertBooks(books(), before);
        assertEq(quote.balanceOf(user), 10e6, "user's wallet");
        assertEq(vault.balanceOf(address(quote)), STAKE, "token's balance in the vault");
    }

    function test_RevertWhen_TheQuoteTokenReentersWithdrawWhileTheDexPullsIt() public {
        (uint256 triggerId, IVault.SignedResponse memory p1) = openAndWait();
        quote.arm(HookedToken.transferFrom.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), true);
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(reentrancyError());
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(address(quote)), STAKE, "token's balance in the vault");
    }

    function test_RevertWhen_TheQuoteTokenReentersWithdrawWhileTheDexPaysOut() public {
        uint256 positionId = buyEth();
        IVault.SignedResponse memory price = signedPrice("2240");
        quote.arm(HookedToken.mint.selector, address(vault), abi.encodeCall(IVault.withdraw, (STAKE)), true);
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(reentrancyError());
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
        assertEq(vault.balanceOf(address(quote)), STAKE, "token's balance in the vault");
    }

    function test_Sell_IgnoresAConfirmThatTheQuoteTokenReentersWhileTheDexPaysOut() public {
        uint256 positionId = buyEth();
        uint256 triggerId = openEthTrigger("2100");
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2180");
        IVault.SignedResponse memory price = signedPrice("2181");
        quote.arm(
            HookedToken.mint.selector, address(vault), abi.encodeCall(IVault.confirmTrigger, (triggerId, p1)), false
        );
        uint256 expectedOut = dex.quoteSell(address(teth), vault.getPosition(positionId).amount, 2181e18);

        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        assertCallbackFailed(quote, reentrancyError());
        assertEq(quoteOut, expectedOut, "quote out");
        assertPositionOpen(positionId, false);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.positionCount(), 1, "position count");
        assertEq(vault.balanceOf(user), 950e6 + expectedOut, "user's balance");
    }
}
