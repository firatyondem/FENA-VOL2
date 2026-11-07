// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FixtureFlowBase} from "./utils/FixtureFlowBase.sol";

/// @notice Integration flow 4: two users, the same signed post and the same signed prices. Both can trigger and buy;
/// the tweet and response replay guards hold per user.
contract TwoUsersFlowTest is FixtureFlowBase {
    uint256 constant DEPOSIT = 500e6;
    uint256 constant BUY = 50e6;

    function setUp() public override {
        super.setUp();
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
        depositAndSetDemoRule(bob, bobAgent, DEPOSIT);
    }

    function test_TwoUsers_SameTweetAndSamePricesBuyForBoth() public {
        Post memory trumpTweet = fixtureTweet("tweet-trump-venezuela");
        Post memory muskTweet = fixtureTweet("tweet-musk-doge");
        bytes[] memory p0 = fixture("eth-p0");
        // eth-p1-early is a valid ETH price one minute after P0; here it serves as the P0 of a second trigger.
        // The first ETH price after the second post: 2000, so the shared P1 would confirm its trend too
        bytes[] memory secondP0 = signedPriceOf(ETH_FEED, "2000", T1_EARLY);

        // Gate 1: each agent opens a trigger for its own user with the same post and the same P0.
        vm.warp(P0_SIGNED_AT);
        vm.prank(aliceAgent);
        uint256 aliceTrigger = openTriggerWith(alice, ETH, trumpTweet, p0);
        vm.prank(bobAgent);
        uint256 bobTrigger = openTriggerWith(bob, ETH, trumpTweet, p0);
        assertEq(vault.getTrigger(aliceTrigger).user, alice);
        assertEq(vault.getTrigger(bobTrigger).user, bob);
        assertEq(vault.getTrigger(aliceTrigger).tweetId, vault.getTrigger(bobTrigger).tweetId);
        assertEq(vault.getTrigger(aliceTrigger).p0, vault.getTrigger(bobTrigger).p0);

        // Bob's agent cannot act for Alice.
        vm.expectRevert(abi.encodeWithSelector(IVault.NotAgent.selector, bobAgent));
        vm.prank(bobAgent);
        openTriggerWith(alice, ETH, muskTweet, secondP0);

        // Alice's tweet guard: the same post cannot open a second ETH trigger for her.
        vm.expectRevert(abi.encodeWithSelector(IVault.TweetAlreadyUsed.selector, alice, ETH, TRUMP_TWEET_ID));
        vm.prank(aliceAgent);
        openTriggerWith(alice, ETH, trumpTweet, p0);

        // Alice's price guard: with a fresh post, the P0 that she already used is refused.
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceAlreadyUsed.selector, ETH, T0));
        vm.prank(aliceAgent);
        openTriggerWith(alice, ETH, muskTweet, p0);

        // A fresh post and a fresh price open a second trigger for Alice.
        vm.warp(P1_EARLY_SIGNED_AT);
        vm.prank(aliceAgent);
        uint256 aliceSecondTrigger = openTriggerWith(alice, ETH, muskTweet, secondP0);
        assertEq(vault.getTrigger(aliceSecondTrigger).tweetId, MUSK_TWEET_ID);
        assertEq(vault.getTrigger(aliceSecondTrigger).t0, T1_EARLY);

        // Gate 2: the same signed P1 confirms both users' triggers.
        vm.warp(P1_SIGNED_AT);
        bytes[] memory p1 = fixture("eth-p1-rise");
        vm.prank(keeper);
        uint256 alicePosition = vault.confirmTrigger(aliceTrigger, p1);
        vm.prank(keeper);
        uint256 bobPosition = vault.confirmTrigger(bobTrigger, p1);

        // Alice cannot use that P1 again, even for another trigger of hers.
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceAlreadyUsed.selector, ETH, T1));
        vm.prank(keeper);
        vault.confirmTrigger(aliceSecondTrigger, p1);
        assertEq(uint256(vault.getTrigger(aliceSecondTrigger).status), uint256(IVault.TriggerStatus.Open));

        // Both bought the same amount at exactly P1, each from their own balance.
        uint256 expectedOut = assetOutAt(BUY, 2070e18);
        IVault.Position memory alicePos = vault.getPosition(alicePosition);
        IVault.Position memory bobPos = vault.getPosition(bobPosition);
        assertEq(alicePos.user, alice);
        assertEq(bobPos.user, bob);
        assertEq(alicePos.entryPrice, 2070e18);
        assertEq(bobPos.entryPrice, 2070e18);
        assertEq(alicePos.amount, expectedOut);
        assertEq(bobPos.amount, expectedOut);
        assertEq(vault.balanceOf(alice), DEPOSIT - BUY);
        assertEq(vault.balanceOf(bob), DEPOSIT - BUY);
        assertEq(vault.spentToday(alice, ETH), BUY);
        assertEq(vault.spentToday(bob, ETH), BUY);
        assertEq(teth.balanceOf(address(vault)), 2 * expectedOut);
        assertEq(usdc.balanceOf(address(dex)), 2 * BUY);
        assertBooksBalance();

        // One signed sell price may sell both positions; each sells once.
        vm.warp(P1_SIGNED_AT + 1 hours);
        bytes[] memory takeProfit = fixtureSignedPrice(ETH_FEED, "2235.6");
        vm.prank(stranger);
        uint256 aliceOut = vault.sell(alicePosition, IVault.SellReason.TakeProfit, takeProfit);
        vm.prank(stranger);
        uint256 bobOut = vault.sell(bobPosition, IVault.SellReason.TakeProfit, takeProfit);
        assertEq(aliceOut, quoteOutAt(expectedOut, 2235.6e18));
        assertEq(bobOut, aliceOut);
        assertEq(vault.balanceOf(alice), DEPOSIT - BUY + aliceOut);
        assertEq(vault.balanceOf(bob), DEPOSIT - BUY + bobOut);
        assertEq(teth.totalSupply(), 0);
        assertBooksBalance();
    }
}
