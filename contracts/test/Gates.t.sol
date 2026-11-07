// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../src/interfaces/IVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice Gate 1: the agent opens a trigger for a post with a Pyth P0, the first price at or after the post
contract GateOneTest is VaultTestBase {
    function test_OpenTrigger_RecordsThePostAndP0() public {
        uint256 postedAt = block.timestamp;
        uint256 triggerId = openEthTrigger("2000.5");

        IVault.Trigger memory trigger = vault.getTrigger(triggerId);
        assertEq(trigger.user, user);
        assertEq(trigger.assetId, ETH);
        assertEq(trigger.account, ACCOUNT);
        assertEq(trigger.tweetId, tweetIdAt(postedAt));
        assertEq(trigger.p0, 2000.5e18);
        assertEq(trigger.t0, postedAt + 1 minutes);
        assertEq(uint256(trigger.status), uint256(IVault.TriggerStatus.Open));
    }

    function test_RevertWhen_TheCallerIsNotTheAgent() public {
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = signedTweet(block.timestamp - 1 minutes);
        bytes[] memory p0 = signedPrice("2000");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVault.NotAgent.selector, keeper));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_TheRuleIsPaused() public {
        vm.prank(user);
        vault.setPaused(true);

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        this.openEthTriggerExternally();
    }

    function test_RevertWhen_TheAssetIsNotInTheRule() public {
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = signedTweet(block.timestamp - 1 minutes);
        bytes[] memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.AssetNotAllowed.selector, user, OIL));
        openTriggerWith(user, OIL, tweet, p0);
    }

    function test_RevertWhen_TheAccountIsNotWatched() public {
        bytes32 otherAccount = keccak256("someoneelse");
        vault.setWatchableAccount(otherAccount, true);
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = postOf(otherAccount, tweetIdAt(block.timestamp - 1 minutes));
        bytes[] memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.AccountNotWatched.selector, user, otherAccount));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_TheAdminRemovedTheAccount() public {
        vault.setWatchableAccount(ACCOUNT, false);
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = signedTweet(block.timestamp - 1 minutes);
        bytes[] memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.AccountNotRegistered.selector, ACCOUNT));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_ThePostOpensASecondTriggerForTheSameAsset() public {
        uint256 postedAt = block.timestamp;
        openEthTrigger("2000");
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPrice("2001");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.TweetAlreadyUsed.selector, user, ETH, tweetIdAt(postedAt)));
        openTriggerWith(user, ETH, tweet, p0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The post's time: posts are not signed, so the vault bounds how old a post the agent may name
    // ---------------------------------------------------------------------------------------------------------------

    function test_OpenTrigger_AcceptsAPostExactlyMaxPostAgeOld() public {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + vault.MAX_POST_AGE());
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPriceAt("2000", postedAt + 1 minutes);
        vm.prank(agent);
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_ThePostIsOlderThanMaxPostAge() public {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + vault.MAX_POST_AGE() + 1);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPriceAt("2000", postedAt + 1 minutes);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PostOutsideWindow.selector, postedAt));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_ThePostIsFromTheFuture() public {
        uint256 postedAt = block.timestamp + 1;
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPriceAt("2000", postedAt);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PostOutsideWindow.selector, postedAt));
        openTriggerWith(user, ETH, tweet, p0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // P0: the first Pyth price at or after the post, at most MAX_POST_TO_P0 after it
    // ---------------------------------------------------------------------------------------------------------------

    function test_OpenTrigger_AcceptsTheFirstPriceAfterThePost() public {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 5 minutes);
        // Pyth's previous price for the feed came a second before the post.
        bytes[] memory p0 = priceUpdate18(ETH_FEED, 2000e18, postedAt + 2, uint64(postedAt - 1));
        Post memory tweet = signedTweet(postedAt);
        vm.prank(agent);
        uint256 triggerId = openTriggerWith(user, ETH, tweet, p0);
        assertEq(vault.getTrigger(triggerId).t0, postedAt + 2);
    }

    function test_OpenTrigger_AcceptsAPricePublishedInTheSecondOfThePost() public {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        bytes[] memory p0 = priceUpdate18(ETH_FEED, 2000e18, postedAt, uint64(postedAt - 1));
        Post memory tweet = signedTweet(postedAt);
        vm.prank(agent);
        uint256 triggerId = openTriggerWith(user, ETH, tweet, p0);
        assertEq(vault.getTrigger(triggerId).t0, postedAt);
    }

    function test_RevertWhen_P0IsNotTheFirstPriceAfterThePost() public {
        // Pyth published another price after the post and before this one, so the agent could have picked the better
        // of the two.
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 5 minutes);
        bytes[] memory p0 = priceUpdate18(ETH_FEED, 1990e18, postedAt + 3 minutes, uint64(postedAt + 2 minutes));
        Post memory tweet = signedTweet(postedAt);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceNotFirstAfterPost.selector, postedAt, postedAt + 3 minutes));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_P0WasPublishedTooLongAfterThePost() public {
        uint256 postedAt = block.timestamp;
        uint256 late = postedAt + vault.MAX_POST_TO_P0() + 1;
        vm.warp(late);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPriceAt("2000", late);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, late));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_OpenTrigger_AcceptsP0ExactlyMaxPostToP0AfterThePost() public {
        uint256 postedAt = block.timestamp;
        uint256 latest = postedAt + vault.MAX_POST_TO_P0();
        vm.warp(latest);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPriceAt("2000", latest);
        vm.prank(agent);
        uint256 triggerId = openTriggerWith(user, ETH, tweet, p0);
        assertEq(vault.getTrigger(triggerId).t0, latest);
    }

    function test_RevertWhen_P0WasPublishedBeforeThePost() public {
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = signedTweet(block.timestamp);
        bytes[] memory p0 = signedPriceAt("2000", block.timestamp - 1);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, block.timestamp, block.timestamp - 1)
        );
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_TheMarketWasClosedAfterThePost() public {
        // A stock's post after the close: Pyth published no price in the ten minutes after it, and the next one comes
        // at the open.
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 20 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory lastClose = signedPriceAt("2000", postedAt - 6 minutes);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, postedAt - 6 minutes));
        openTriggerWith(user, ETH, tweet, lastClose);
    }

    function test_RevertWhen_P0IsForAnotherAsset() public {
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = signedTweet(block.timestamp - 1 minutes);
        bytes[] memory p0 = signedPriceOf(BTC_FEED, "80000", block.timestamp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.WrongPriceFeed.selector, ETH_FEED));
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_P0IsEdited() public {
        vm.warp(block.timestamp + 1 minutes);
        Post memory tweet = signedTweet(block.timestamp - 1 minutes);
        bytes[] memory p0 = edited(signedPrice("1500"));

        vm.prank(agent);
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_RevertWhen_P0IsUsedTwice() public {
        // Two posts in the same minute share the first price after them, but a P0 opens one trigger per user and asset.
        uint256 firstPostAt = block.timestamp;
        vm.warp(firstPostAt + 1 minutes);
        bytes[] memory p0 = signedPrice("2000");
        Post memory firstTweet = signedTweet(firstPostAt);
        vm.prank(agent);
        openTriggerWith(user, ETH, firstTweet, p0);

        Post memory secondTweet = signedTweet(firstPostAt + 30);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceAlreadyUsed.selector, ETH, block.timestamp));
        openTriggerWith(user, ETH, secondTweet, p0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Pyth's fee
    // ---------------------------------------------------------------------------------------------------------------

    function test_OpenTrigger_PaysPythsFeeAndRefundsTheRest() public {
        pyth.setFee(10);
        vm.deal(agent, 1 ether);
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        bytes[] memory p0 = signedPrice("2000");
        assertEq(vault.updateFee(p0), 10);

        vm.prank(agent);
        vault.openTrigger{value: 1000}(user, ETH, ACCOUNT, tweetIdAt(postedAt), p0);
        assertEq(address(pyth).balance, 10, "Pyth's fee");
        assertEq(agent.balance, 1 ether - 10, "the rest comes back");
        assertEq(address(vault).balance, 0, "the vault keeps nothing");
    }

    function test_RevertWhen_TheFeeIsTooLow() public {
        pyth.setFee(10);
        vm.deal(agent, 1 ether);
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        bytes[] memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientFee.selector, 9, 10));
        vault.openTrigger{value: 9}(user, ETH, ACCOUNT, tweetIdAt(postedAt), p0);
    }

    function test_ARefusedP0CostsOnlyOneFee() public {
        // The vault parses a refused P0 a second time to name the reason, paid with the fee of the first call.
        pyth.setFee(10);
        vm.deal(agent, 1 ether);
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 5 minutes);
        bytes[] memory p0 = priceUpdate18(ETH_FEED, 2000e18, postedAt + 3 minutes, uint64(postedAt + 2 minutes));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceNotFirstAfterPost.selector, postedAt, postedAt + 3 minutes));
        vault.openTrigger{value: 10}(user, ETH, ACCOUNT, tweetIdAt(postedAt), p0);
    }

    function openEthTriggerExternally() external returns (uint256) {
        return openEthTrigger("2000");
    }
}

/// @notice Gate 2: anyone confirms a trigger with a Pyth P1, and the vault buys only if every check passes
contract GateTwoTest is VaultTestBase {
    uint256 triggerId;
    uint256 t0;

    function setUp() public override {
        super.setUp();
        triggerId = openEthTrigger("2000");
        t0 = block.timestamp;
    }

    function test_RevertWhen_TheMinimumWaitIsNotOver() public {
        vm.warp(t0 + 29 minutes);
        bytes[] memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + 30 minutes));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_P1IsOutsideTheWindow() public {
        vm.warp(t0 + 4 hours + 1);
        bytes[] memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WindowClosed.selector, t0 + 4 hours));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheTrendIsTooWeak() public {
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("2059.99");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2059.99e18));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysAtExactlyTheThreshold() public {
        vm.warp(t0 + 31 minutes);
        vault.confirmTrigger(triggerId, signedPrice("2060"));
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Confirmed));
    }

    function test_RevertWhen_ThePriceSpikesAboveTheCap() public {
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("2240.01");

        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 2000e18, 2240.01e18));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_AWeakP1KeepsTheTriggerOpenForALaterOne() public {
        vm.warp(t0 + 31 minutes);
        bytes[] memory weak = signedPrice("2010");
        vm.expectPartialRevert(IVault.TrendTooWeak.selector);
        vault.confirmTrigger(triggerId, weak);

        vm.warp(t0 + 2 hours);
        vault.confirmTrigger(triggerId, signedPrice("2080"));
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Confirmed));
    }

    function test_RevertWhen_TheTriggerIsConfirmedTwice() public {
        vm.warp(t0 + 31 minutes);
        vault.confirmTrigger(triggerId, signedPrice("2070"));
        vm.warp(block.timestamp + 1);
        bytes[] memory again = signedPrice("2071");

        vm.expectRevert(abi.encodeWithSelector(IVault.TriggerNotOpen.selector, triggerId));
        vault.confirmTrigger(triggerId, again);
    }

    function test_ExpireTrigger_ClosesTheTriggerAfterTheWindow() public {
        vm.expectRevert(abi.encodeWithSelector(IVault.WindowNotClosed.selector, t0 + 4 hours));
        vault.expireTrigger(triggerId);

        vm.warp(t0 + 4 hours + 1);
        vm.expectEmit(address(vault));
        emit IVault.TriggerExpired(triggerId);
        vault.expireTrigger(triggerId);
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Expired));
        assertEq(vault.balanceOf(user), 1_000e6);
    }

    function test_RevertWhen_TheRuleIsPausedAtConfirmation() public {
        vm.prank(user);
        vault.setPaused(true);
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheCooldownIsActive() public {
        vm.warp(t0 + 31 minutes);
        vault.confirmTrigger(triggerId, signedPrice("2070"));
        uint256 boughtAt = block.timestamp;

        uint256 secondTriggerId = openEthTrigger("2070");
        vm.warp(block.timestamp + 31 minutes);
        bytes[] memory p1 = signedPrice("2140");

        vm.expectRevert(abi.encodeWithSelector(IVault.CooldownActive.selector, boughtAt + 24 hours));
        vault.confirmTrigger(secondTriggerId, p1);
    }

    function test_RevertWhen_TheAssetsBudgetShareIsSpent() public {
        // ETH gets 30% of the 200 USDC daily limit, so 60 USDC: one 50 USDC buy fits, a second does not.
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.budgetShareBps = 3_000;
        assetRule.cooldown = 0;
        vm.prank(user);
        setEthRule(assetRule);

        vm.warp(t0 + 31 minutes);
        vault.confirmTrigger(triggerId, signedPrice("2070"));
        assertEq(vault.spentToday(user, ETH), 50e6);

        uint256 secondTriggerId = openEthTrigger("2070");
        vm.warp(block.timestamp + 31 minutes);
        bytes[] memory p1 = signedPrice("2140");

        vm.expectRevert(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 10e6));
        vault.confirmTrigger(secondTriggerId, p1);
    }

    function test_RevertWhen_TheBalanceIsTooLow() public {
        vm.prank(user);
        vault.withdraw(960e6);
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientBalance.selector, 40e6, 50e6));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheUserTookTheAssetOutOfTheRule() public {
        vm.prank(user);
        vault.setRule(rule(), new bytes32[](0), new IVault.AssetRule[](0), new string[](0), watched());
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.AssetNotAllowed.selector, user, ETH));
        vault.confirmTrigger(triggerId, p1);

        // The trigger has no window left, so anyone can close it.
        vault.expireTrigger(triggerId);
    }
}
