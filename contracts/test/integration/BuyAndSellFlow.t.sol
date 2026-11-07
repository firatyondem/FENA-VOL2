// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {FixtureFlowBase} from "./utils/FixtureFlowBase.sol";

/// @notice Integration flows 1 and 2: deposit, a rule with three assets, Gate 1 and Gate 2 on Person B's signed
/// fixtures, a buy at exactly P1 on the real MockDEX, and a take-profit, stagnation or manual sell, after which every
/// balance reconciles
contract BuyAndSellFlowTest is FixtureFlowBase {
    uint256 constant DEPOSIT = 500e6;
    uint256 constant BUY = 50e6;

    // ---------------------------------------------------------------------------------------------------------------
    // Flow 1: take profit
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev tweet-trump-venezuela -> oil-p0 (70.25) -> oil-p1-rise (71.4, +1.64%) -> take profit at 71.4 * 1.08
    function test_TakeProfit_FromDepositToAClosedPosition() public {
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
        uint256 usdcSupplyBefore = usdc.totalSupply();

        // Gate 1: the agent opens the trigger one second after the source took P0
        vm.warp(P0_SIGNED_AT);
        Post memory tweet = fixtureTweet("tweet-trump-venezuela");
        bytes[] memory p0 = fixture("oil-p0");
        vm.expectEmit(address(vault));
        emit IVault.TriggerOpened(1, alice, OIL, TRUMP_TWEET_ID, 70.25e18, T0);
        vm.prank(aliceAgent);
        uint256 triggerId = openTriggerWith(alice, OIL, tweet, p0);
        IVault.Trigger memory trigger = vault.getTrigger(triggerId);
        assertEq(trigger.account, trumpAccount);
        assertEq(trigger.tweetId, TRUMP_TWEET_ID);
        assertEq(trigger.p0, 70.25e18);
        assertEq(trigger.t0, T0);
        assertEq(uint256(trigger.status), uint256(IVault.TriggerStatus.Open));
        // Opening a trigger moves no money.
        assertEq(vault.balanceOf(alice), DEPOSIT);

        // Gate 2: past the minimum wait, anyone confirms with P1, and the vault buys at exactly P1
        vm.warp(P1_SIGNED_AT);
        bytes[] memory p1 = fixture("oil-p1-rise");
        uint256 expectedOut = assetOutAt(BUY, 71.4e18);
        assertEq(expectedOut, dex.quoteBuy(address(toil), BUY, 71.4e18));
        vm.expectEmit(address(dex));
        emit MockDEX.Bought(address(vault), address(toil), BUY, expectedOut, 71.4e18);
        vm.expectEmit(address(vault));
        emit IVault.TriggerConfirmed(triggerId, 1, 71.4e18, T1, BUY, expectedOut);
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, p1);

        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Confirmed));
        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.user, alice);
        assertEq(position.assetId, OIL);
        assertEq(position.amount, expectedOut);
        assertEq(position.cost, BUY);
        assertEq(position.entryPrice, 71.4e18);
        assertEq(position.openedAt, P1_SIGNED_AT);
        assertTrue(position.isOpen);
        assertEq(vault.balanceOf(alice), DEPOSIT - BUY);
        assertEq(vault.spentToday(alice, OIL), BUY);
        assertEq(toil.balanceOf(address(vault)), expectedOut);
        // The DEX keeps the USDC that it pulls on a buy.
        assertEq(usdc.balanceOf(address(dex)), BUY);
        assertBooksBalance();

        // Take profit: anyone sells at a signed price of exactly entry * 1.08
        vm.warp(P1_SIGNED_AT + 1 hours);
        uint256 target = 71.4e18 * (BPS + 800) / BPS;
        assertEq(target, 77.112e18);
        bytes[] memory price = fixtureSignedPrice(OIL_FEED, "77.112");
        uint256 expectedQuote = quoteOutAt(expectedOut, target);
        vm.expectEmit(address(vault));
        emit IVault.PositionSold(positionId, alice, IVault.SellReason.TakeProfit, target, expectedQuote);
        vm.prank(stranger);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, price);

        // Closed, at a profit of 8% less at most one micro-USDC of rounding per swap
        assertEq(quoteOut, expectedQuote);
        assertGt(quoteOut, BUY);
        assertLe(quoteOut, BUY * (BPS + 800) / BPS);
        assertGe(quoteOut, BUY * (BPS + 800) / BPS - 2);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertEq(vault.balanceOf(alice), DEPOSIT - BUY + quoteOut);
        assertEq(toil.balanceOf(address(vault)), 0);
        assertEq(toil.totalSupply(), 0);
        assertEq(usdc.balanceOf(address(dex)), BUY);
        // The DEX minted the proceeds.
        assertEq(usdc.totalSupply(), usdcSupplyBefore + quoteOut);
        assertBooksBalance();

        // The position sells only once.
        vm.expectRevert(abi.encodeWithSelector(IVault.PositionNotOpen.selector, positionId));
        vm.prank(stranger);
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);

        // Alice takes everything out.
        vm.prank(alice);
        vault.withdraw(DEPOSIT - BUY + quoteOut);
        assertEq(usdc.balanceOf(alice), DEPOSIT - BUY + quoteOut);
        assertEq(vault.balanceOf(alice), 0);
        assertBooksBalance();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Flow 2: stagnation exit and manual sell
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev eth-p0 (2000) -> eth-p1-early rejected -> eth-p1-rise (2070) -> a price still within 2070 +- 1% after the
    /// stagnation delay
    function test_StagnationExit_SellsAfterTheDelayWithinTheBand() public {
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
        vm.warp(P0_SIGNED_AT);
        uint256 triggerId = openWithFixtures(alice, aliceAgent, ETH, "tweet-trump-venezuela", "eth-p0");

        // A P1 one minute after P0 is before the 2-minute wait; the trigger stays open.
        vm.warp(P1_EARLY_SIGNED_AT);
        bytes[] memory early = fixture("eth-p1-early");
        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, T0 + 2 minutes));
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, early);
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Open));

        uint256 positionId = confirmEthRise(triggerId);
        uint256 amount = vault.getPosition(positionId).amount;
        uint256 openedAt = block.timestamp;

        // One second before the 10-minute stagnation delay, the exit is refused.
        vm.warp(openedAt + 10 minutes - 1);
        bytes[] memory tooSoon = fixtureSignedPrice(ETH_FEED, "2060");
        vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, openedAt + 10 minutes));
        vm.prank(stranger);
        vault.sell(positionId, IVault.SellReason.Stagnation, tooSoon);

        // After the delay, anyone sells at 2060, within 2070 +- 1%.
        vm.warp(openedAt + 10 minutes);
        bytes[] memory price = fixtureSignedPrice(ETH_FEED, "2060");
        uint256 expectedQuote = quoteOutAt(amount, 2060e18);
        vm.expectEmit(address(vault));
        emit IVault.PositionSold(positionId, alice, IVault.SellReason.Stagnation, 2060e18, expectedQuote);
        vm.prank(stranger);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Stagnation, price);

        assertEq(quoteOut, expectedQuote);
        assertLt(quoteOut, BUY);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertEq(vault.balanceOf(alice), DEPOSIT - BUY + quoteOut);
        assertEq(teth.totalSupply(), 0);
        assertEq(usdc.balanceOf(address(dex)), BUY);
        assertBooksBalance();
    }

    /// @dev eth-p0 (2000) -> eth-p1-flat and eth-p1-spike rejected -> eth-p1-rise (2070) -> Alice sells by hand at a
    /// loss
    function test_ManualSell_TheOwnerSellsAtAnyTime() public {
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
        vm.warp(P0_SIGNED_AT);
        uint256 triggerId = openWithFixtures(alice, aliceAgent, ETH, "tweet-trump-venezuela", "eth-p0");

        // +0.5% is below the 3% threshold and +15% above the 12% spike cap; neither buys and the trigger stays open.
        vm.warp(P1_SIGNED_AT);
        bytes[] memory flat = fixture("eth-p1-flat");
        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2010e18));
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, flat);
        bytes[] memory spike = fixture("eth-p1-spike");
        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 2000e18, 2300e18));
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, spike);

        uint256 positionId = confirmEthRise(triggerId);
        uint256 amount = vault.getPosition(positionId).amount;

        // Ten minutes later the price has dropped; only Alice may sell by hand.
        vm.warp(block.timestamp + 10 minutes);
        bytes[] memory price = fixtureSignedPrice(ETH_FEED, "1950");
        vm.expectRevert(abi.encodeWithSelector(IVault.NotPositionOwner.selector, stranger));
        vm.prank(stranger);
        vault.sell(positionId, IVault.SellReason.Manual, price);

        uint256 expectedQuote = quoteOutAt(amount, 1950e18);
        vm.expectEmit(address(vault));
        emit IVault.PositionSold(positionId, alice, IVault.SellReason.Manual, 1950e18, expectedQuote);
        vm.prank(alice);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        assertEq(quoteOut, expectedQuote);
        assertLt(quoteOut, BUY);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertEq(vault.balanceOf(alice), DEPOSIT - BUY + quoteOut);
        assertEq(teth.totalSupply(), 0);
        assertBooksBalance();

        vm.expectRevert(abi.encodeWithSelector(IVault.PositionNotOpen.selector, positionId));
        vm.prank(alice);
        vault.sell(positionId, IVault.SellReason.Manual, price);

        vm.prank(alice);
        vault.withdraw(DEPOSIT - BUY + quoteOut);
        assertEq(usdc.balanceOf(alice), DEPOSIT - BUY + quoteOut);
        assertBooksBalance();
    }

    /// @dev Confirms an ETH trigger with eth-p1-rise and checks the buy at exactly 2070
    function confirmEthRise(uint256 triggerId) private returns (uint256 positionId) {
        vm.warp(P1_SIGNED_AT);
        bytes[] memory p1 = fixture("eth-p1-rise");
        uint256 expectedOut = assetOutAt(BUY, 2070e18);
        vm.expectEmit(address(dex));
        emit MockDEX.Bought(address(vault), address(teth), BUY, expectedOut, 2070e18);
        vm.expectEmit(address(vault));
        emit IVault.TriggerConfirmed(triggerId, 1, 2070e18, T1, BUY, expectedOut);
        vm.prank(keeper);
        positionId = vault.confirmTrigger(triggerId, p1);

        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.entryPrice, 2070e18);
        assertEq(position.amount, expectedOut);
        assertEq(vault.balanceOf(alice), DEPOSIT - BUY);
        assertEq(vault.spentToday(alice, ETH), BUY);
        assertBooksBalance();
    }
}
