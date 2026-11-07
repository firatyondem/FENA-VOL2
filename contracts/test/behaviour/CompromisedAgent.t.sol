// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {BehaviourBase} from "./BehaviourBase.sol";
import {FixtureBase} from "./FixtureBase.sol";

/// @notice A compromised agent wallet with Person B's genuine signed posts and prices: it may open triggers only for the
/// user's allowed assets and watched accounts, once per post, and only with a P0 close after the post
/// @dev The user's rule allows ETH only and watches realDonaldTrump only; OIL and elonmusk are registered with the vault.
contract CompromisedAgentFixtureTest is FixtureBase {
    function test_RevertWhen_TheAgentOpensATriggerForADisallowedAsset() public {
        // A genuine oil price after a genuine post of a watched account, but oil is not in the user's rule
        expectRejectedOpen(
            OIL,
            fixtureTweet("tweet-trump-venezuela"),
            fixture("oil-p0"),
            abi.encodeWithSelector(IVault.AssetNotAllowed.selector, user, OIL)
        );
    }

    function test_RevertWhen_TheAgentOpensATriggerForAnUnregisteredAsset() public {
        bytes32 doge = keccak256("DOGE");

        expectRejectedOpen(
            doge,
            fixtureTweet("tweet-trump-venezuela"),
            fixture("eth-p0"),
            abi.encodeWithSelector(IVault.AssetNotAllowed.selector, user, doge)
        );
    }

    function test_RevertWhen_TheAgentOpensATriggerForAnUnwatchedAccount() public {
        // elonmusk is registered with the vault, but the user does not watch it
        expectRejectedOpen(
            ETH,
            fixtureTweet("tweet-musk-doge"),
            fixture("eth-p0"),
            abi.encodeWithSelector(IVault.AccountNotWatched.selector, user, muskAccount)
        );
    }

    function test_RevertWhen_TheAgentRepeatsATweet() public {
        uint256 triggerId = openWith(user, agent, ETH, fixtureTweet("tweet-trump-venezuela"), fixture("eth-p0"));
        assertEq(vault.getTrigger(triggerId).tweetId, TRUMP_TWEET_ID, "tweet ID");

        // The same post with a P0 that has not been used yet
        expectRejectedOpen(
            ETH,
            fixtureTweet("tweet-trump-venezuela"),
            fixture("eth-p1-early"),
            abi.encodeWithSelector(IVault.TweetAlreadyUsed.selector, user, ETH, TRUMP_TWEET_ID)
        );
    }

    function test_RevertWhen_TheAgentPairsAnOldTweetWithAFreshPrice() public {
        // A two-day-old post with a fresh price
        expectRejectedOpen(
            ETH,
            fixtureTweet("tweet-trump-old"),
            fixture("eth-p0"),
            abi.encodeWithSelector(IVault.PostOutsideWindow.selector, OLD_TWEET_CREATED_AT)
        );
    }

    function test_RevertWhen_TheAgentOpensATriggerForAnotherUser() public {
        fund(user2, 1_000e6);
        setSyntheticRule(user2, agent2, accountList(trumpAccount));
        Books memory before = books();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.NotAgent.selector, agent));
        openTriggerWith(user2, ETH, fixtureTweet("tweet-trump-venezuela"), fixture("eth-p0"));

        assertBooks(books(), before);
    }

    function test_RevertWhen_TheAgentConfirmsAFlatPrice() public {
        // The agent opened a trigger on a genuine post, but the signed prices do not confirm a trend.
        uint256 triggerId = openWith(user, agent, ETH, fixtureTweet("tweet-trump-venezuela"), fixture("eth-p0"));
        vm.warp(CONFIRM_AT);
        Books memory before = books();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2010e18));
        vault.confirmTrigger(triggerId, fixture("eth-p1-flat"));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 2000e18, 2300e18));
        vault.confirmTrigger(triggerId, fixture("eth-p1-spike"));
        assertBooks(books(), before);

        // The trigger expires once its window has closed, and nothing has moved.
        vm.warp(T0 + 10 minutes + 1);
        vault.expireTrigger(triggerId);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Expired);
        assertBooks(books(), before);
    }

    /// @dev The agent's open reverts with `expectedError` and opens nothing
    function expectRejectedOpen(bytes32 assetId, Post memory tweet, bytes[] memory p0, bytes memory expectedError)
        private
    {
        Books memory before = books();

        vm.prank(agent);
        vm.expectRevert(expectedError);
        openTriggerWith(user, assetId, tweet, p0);

        assertBooks(books(), before);
    }
}

/// @notice A compromised agent wallet with its own keys: it cannot forge signed data, reuse a post, unpause the user,
/// withdraw the user's funds, or sell a position to itself
contract CompromisedAgentTest is BehaviourBase {
    // ---------------------------------------------------------------------------------------------------------------
    // Gate 1
    // ---------------------------------------------------------------------------------------------------------------

    function test_AMadeUpPostOnlyOpensAPriceCheck() public {
        // Posts are not signed, so the agent can name a post that never happened. The trigger opens, but the vault buys
        // only if Pyth's later price confirms the rise, and the money stays put when it does not.
        uint256 madeUpAt = block.timestamp;
        vm.warp(madeUpAt + 1 minutes);
        Post memory madeUp = postOf(ACCOUNT, tweetIdAt(madeUpAt));
        bytes[] memory p0 = signedPrice("2000");
        vm.prank(agent);
        uint256 triggerId = openTriggerWith(user, ETH, madeUp, p0);
        Books memory before = books();

        vm.warp(block.timestamp + 31 minutes);
        bytes[] memory flat = signedPrice("2001");
        vm.expectPartialRevert(IVault.TrendTooWeak.selector);
        vault.confirmTrigger(triggerId, flat);
        assertBooks(books(), before);
    }

    function test_RevertWhen_TheAgentSignsAP0Itself() public {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        bytes[] memory p0 = edited(signedPrice("1000"));

        vm.prank(agent);
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        openTriggerWith(user, ETH, signedTweet(postedAt), p0);
        assertEq(vault.triggerCount(), 0, "trigger count");
    }

    function test_RevertWhen_TheAgentRepeatsATweetForAnyAsset() public {
        // One post may open one trigger per asset of the rule, never a second one for the same asset.
        IVault.AssetRule memory ethHalf = ethRule();
        ethHalf.budgetShareBps = 5_000;
        vm.prank(user);
        vault.setRule(rule(), two(ETH, OIL), twoRules(ethHalf, oilRule()), topics(2), watched());
        uint256 postedAt = block.timestamp;
        uint256 tweetId = tweetIdAt(postedAt);
        vm.warp(postedAt + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        vm.startPrank(agent);
        openTriggerWith(user, ETH, tweet, signedPrice("2000"));
        openTriggerWith(user, OIL, tweet, signedPriceOf(OIL_FEED, "70", block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(IVault.TweetAlreadyUsed.selector, user, ETH, tweetId));
        openTriggerWith(user, ETH, tweet, signedPrice("2001"));
        vm.expectRevert(abi.encodeWithSelector(IVault.TweetAlreadyUsed.selector, user, OIL, tweetId));
        openTriggerWith(user, OIL, tweet, signedPriceOf(OIL_FEED, "71", block.timestamp));
        vm.stopPrank();
        assertEq(vault.triggerCount(), 2, "trigger count");
    }

    function test_RevertWhen_TheAgentRepeatsATweetAfterTheTriggerExpired() public {
        useShortWindows();
        uint256 postedAt = block.timestamp;
        uint256 triggerId = openEthTrigger("2000");
        // Three minutes after the post: the window has closed, but a P0 could still pair with the post.
        vm.warp(vault.getTrigger(triggerId).t0 + 2 minutes + 1);
        vault.expireTrigger(triggerId);

        expectRepeatedTweet(postedAt);
    }

    function test_RevertWhen_TheAgentRepeatsATweetAfterTheBuy() public {
        useShortWindows();
        uint256 postedAt = block.timestamp;
        uint256 triggerId = openEthTrigger("2000");
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory p1 = signedPrice("2070");
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, p1);

        expectRepeatedTweet(postedAt);
    }

    function test_RevertWhen_TheAgentRepeatsATweetAfterTheUserResetsTheRule() public {
        uint256 postedAt = block.timestamp;
        openEthTrigger("2000");
        vm.prank(user);
        setEthRule(ethRule());

        expectRepeatedTweet(postedAt);
    }

    function test_RevertWhen_TheAgentUnpausesTheUser() public {
        vm.prank(user);
        vault.setPaused(true);

        // setPaused pauses or resumes the caller's own rule only.
        vm.prank(agent);
        vault.setPaused(false);
        assertTrue(vault.isPaused(user), "user is still paused");

        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPrice("2000");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_SetRule_ByTheAgentLeavesTheUsersRuleAlone() public {
        IVault.Rule memory greedy = IVault.Rule({agent: agent, buyAmount: 1_000e6, maxPerTrade: 1_000e6, dailyLimit: 0});

        vm.prank(agent);
        vault.setRule(greedy, one(ETH), oneRule(ethRule()), topics(1), watched());

        (IVault.Rule memory stored,,) = vault.getRule(user);
        assertEq(stored.buyAmount, 50e6, "user's buy amount");
        assertEq(stored.dailyLimit, 200e6, "user's daily limit");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Funds
    // ---------------------------------------------------------------------------------------------------------------

    function test_RevertWhen_TheAgentWithdrawsTheUsersFunds() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientBalance.selector, 0, 1_000e6));
        vault.withdraw(1_000e6);
        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientBalance.selector, 0, 1));
        vault.withdraw(1);
        vm.stopPrank();

        assertEq(vault.balanceOf(user), 1_000e6, "user's balance");
        assertEq(usdc.balanceOf(agent), 0, "agent's wallet");
        assertEq(usdc.balanceOf(address(vault)), 1_000e6, "quote tokens in the vault");
    }

    function test_RevertWhen_TheAgentWithdrawsTheProceedsOfASell() public {
        uint256 positionId = buyEth();
        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, signedPrice("2100"));
        uint256 balance = vault.balanceOf(user);
        assertEq(balance, 950e6 + quoteOut, "user's balance");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientBalance.selector, 0, quoteOut));
        vault.withdraw(quoteOut);

        assertEq(vault.balanceOf(user), balance, "user's balance after the attempt");
        assertEq(usdc.balanceOf(agent), 0, "agent's wallet");
    }

    function test_RevertWhen_TheAgentSellsAPositionByHand() public {
        uint256 positionId = buyEth();
        bytes[] memory price = signedPrice("2100");
        Books memory before = books();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.NotPositionOwner.selector, agent));
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    function test_RevertWhen_TheAgentSellsBeforeTakeProfit() public {
        uint256 positionId = buyEth();
        bytes[] memory price = signedPrice("2100");
        Books memory before = books();

        // Entry 2070 + 8% = 2235.6
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.TakeProfitNotReached.selector, 2100e18, 2235.6e18));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    function test_RevertWhen_TheAgentSellsForStagnationBeforeTheDelay() public {
        uint256 positionId = buyEth();
        uint256 openedAt = vault.getPosition(positionId).openedAt;
        vm.warp(block.timestamp + 1 hours);
        bytes[] memory price = signedPrice("2070");
        Books memory before = books();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, openedAt + 24 hours));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    function test_RevertWhen_TheAgentSellsAtAPriceItSigned() public {
        uint256 positionId = buyEth();
        // A take-profit price that Pyth did not sign
        bytes[] memory price = edited(signedPrice("9999"));
        Books memory before = books();

        vm.prank(agent);
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    function test_Sell_PaysTheUserWhenTheAgentTakesProfit() public {
        uint256 positionId = buyEth();
        uint256 amount = vault.getPosition(positionId).amount;
        bytes[] memory price = signedPrice("2240");
        uint256 expectedOut = dex.quoteSell(address(teth), amount, 2240e18);

        vm.expectEmit(address(vault));
        emit IVault.PositionSold(positionId, user, IVault.SellReason.TakeProfit, 2240e18, expectedOut);
        vm.prank(agent);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, price);

        assertEq(quoteOut, expectedOut, "quote out");
        assertEq(vault.balanceOf(user), 950e6 + expectedOut, "user's balance");
        assertEq(vault.balanceOf(agent), 0, "agent's balance in the vault");
        assertEq(usdc.balanceOf(agent), 0, "agent's quote tokens");
        assertEq(teth.balanceOf(agent), 0, "agent's asset tokens");
        assertEq(usdc.balanceOf(address(vault)), 950e6 + expectedOut, "quote tokens in the vault");
    }

    function test_Sell_PaysTheUserWhenTheAgentSellsForStagnation() public {
        uint256 positionId = buyEth();
        uint256 amount = vault.getPosition(positionId).amount;
        vm.warp(block.timestamp + 24 hours);
        // Within 1% of the 2070 entry
        bytes[] memory price = signedPrice("2060");
        uint256 expectedOut = dex.quoteSell(address(teth), amount, 2060e18);

        vm.prank(agent);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Stagnation, price);

        assertEq(quoteOut, expectedOut, "quote out");
        assertEq(vault.balanceOf(user), 950e6 + expectedOut, "user's balance");
        assertEq(vault.balanceOf(agent), 0, "agent's balance in the vault");
        assertEq(usdc.balanceOf(agent), 0, "agent's quote tokens");
    }

    /// @dev An ETH profile and rule with a 1 min wait and a 2 min window, so a trigger expires or buys while a fresh P0
    /// can still pair with its post (at most 10 minutes after it)
    function useShortWindows() private {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minWait = 1 minutes;
        profile.maxWindow = 2 minutes;
        vault.setAssetProfile(ETH, profile);
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.minWait = 1 minutes;
        assetRule.maxWindow = 2 minutes;
        vm.prank(user);
        setEthRule(assetRule);
    }

    /// @dev The post from `postedAt`, signed again now, with a fresh, unused P0 that is still within ten minutes of the
    /// post: only the used post stops the trigger, and another post with the same P0 opens one.
    function expectRepeatedTweet(uint256 postedAt) private {
        assertLe(block.timestamp, postedAt + 10 minutes, "P0 can no longer pair with the post");
        uint256 tweetId = tweetIdAt(postedAt);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPrice("2001");
        uint256 triggerCount = vault.triggerCount();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.TweetAlreadyUsed.selector, user, ETH, tweetId));
        openTriggerWith(user, ETH, tweet, p0);
        assertEq(vault.triggerCount(), triggerCount, "trigger count");

        // Control: a different post from the same moment opens a trigger. Its P0 comes a second later, since each
        // price opens or confirms once per user and asset.
        vm.warp(block.timestamp + 1);
        Post memory otherTweet = signedTweetWithId(ACCOUNT, tweetId + 1);
        bytes[] memory nextP0 = signedPrice("2001");
        vm.prank(agent);
        openTriggerWith(user, ETH, otherTweet, nextP0);
        assertEq(vault.triggerCount(), triggerCount + 1, "trigger count after another post");
    }
}
