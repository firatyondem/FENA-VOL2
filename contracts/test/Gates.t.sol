// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../src/interfaces/IVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice Gate 1: the agent opens a trigger with a signed post and a signed P0
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
        IVault.SignedResponse memory tweet = signedTweet(block.timestamp - 1 minutes);
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVault.NotAgent.selector, keeper));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_TheRuleIsPaused() public {
        vm.prank(user);
        vault.setPaused(true);

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        this.openEthTriggerExternally();
    }

    function test_RevertWhen_TheAssetIsNotInTheRule() public {
        vm.warp(block.timestamp + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(block.timestamp - 1 minutes);
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.AssetNotAllowed.selector, user, OIL));
        vault.openTrigger(user, OIL, tweet, p0);
    }

    function test_RevertWhen_TheAccountIsNotWatched() public {
        bytes32 otherAccount = keccak256("userLastTweets someoneElse");
        vault.setWatchableAccount(otherAccount, tweetAirnode);
        vm.warp(block.timestamp + 1 minutes);
        uint256 tweetId = tweetIdAt(block.timestamp - 1 minutes);
        IVault.SignedResponse memory tweet = sign(
            tweetAirnodeKey, otherAccount, block.timestamp, bytes(string.concat('{"id":"', vm.toString(tweetId), '"}'))
        );
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.AccountNotWatched.selector, user, otherAccount));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_ThePostOpensASecondTriggerForTheSameAsset() public {
        uint256 postedAt = block.timestamp;
        openEthTrigger("2000");
        vm.warp(block.timestamp + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(postedAt);
        IVault.SignedResponse memory p0 = signedPrice("2001");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.TweetAlreadyUsed.selector, user, ETH, tweetIdAt(postedAt)));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_AnOldPostComesWithANewPrice() public {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + vault.MAX_POST_TO_P0() + 1);
        IVault.SignedResponse memory tweet = signedTweet(postedAt);
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, block.timestamp));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_P0WasTakenBeforeThePost() public {
        vm.warp(block.timestamp + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(block.timestamp);
        IVault.SignedResponse memory p0 = signedPriceAt("2000", block.timestamp - 1);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, block.timestamp, block.timestamp - 1)
        );
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_TheMarketIsClosed() public {
        // A fresh signature over a price that the source took 6 minutes ago, as for a stock after the close
        vm.warp(block.timestamp + 7 minutes);
        IVault.SignedResponse memory tweet = signedTweet(block.timestamp - 7 minutes);
        IVault.SignedResponse memory p0 = signedPriceAt("2000", block.timestamp - 6 minutes);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, block.timestamp - 6 minutes));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_P0IsUsedTwice() public {
        uint256 firstPostAt = block.timestamp;
        vm.warp(firstPostAt + 1 minutes);
        IVault.SignedResponse memory p0 = signedPrice("2000");
        vm.prank(agent);
        vault.openTrigger(user, ETH, signedTweet(firstPostAt), p0);

        IVault.SignedResponse memory secondTweet = signedTweet(firstPostAt + 30);
        bytes32 responseHash = keccak256(abi.encode(p0.requestHash, p0.timestamp, p0.data));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseAlreadyUsed.selector, responseHash));
        vault.openTrigger(user, ETH, secondTweet, p0);
    }

    function openEthTriggerExternally() external returns (uint256) {
        return openEthTrigger("2000");
    }
}

/// @notice Gate 2: anyone confirms a trigger with a signed P1, and the vault buys only if every check passes
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
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + 30 minutes));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_P1IsOutsideTheWindow() public {
        vm.warp(t0 + 4 hours + 1);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WindowClosed.selector, t0 + 4 hours));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheTrendIsTooWeak() public {
        vm.warp(t0 + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2059.99");

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
        IVault.SignedResponse memory p1 = signedPrice("2240.01");

        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 2000e18, 2240.01e18));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_AWeakP1KeepsTheTriggerOpenForALaterOne() public {
        vm.warp(t0 + 31 minutes);
        IVault.SignedResponse memory weak = signedPrice("2010");
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
        IVault.SignedResponse memory again = signedPrice("2071");

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
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheCooldownIsActive() public {
        vm.warp(t0 + 31 minutes);
        vault.confirmTrigger(triggerId, signedPrice("2070"));
        uint256 boughtAt = block.timestamp;

        uint256 secondTriggerId = openEthTrigger("2070");
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2140");

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
        IVault.SignedResponse memory p1 = signedPrice("2140");

        vm.expectRevert(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 10e6));
        vault.confirmTrigger(secondTriggerId, p1);
    }

    function test_RevertWhen_TheBalanceIsTooLow() public {
        vm.prank(user);
        vault.withdraw(960e6);
        vm.warp(t0 + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientBalance.selector, 40e6, 50e6));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheUserTookTheAssetOutOfTheRule() public {
        vm.prank(user);
        vault.setRule(rule(), new bytes32[](0), new IVault.AssetRule[](0), new string[](0), watched());
        vm.warp(t0 + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.AssetNotAllowed.selector, user, ETH));
        vault.confirmTrigger(triggerId, p1);

        // The trigger has no window left, so anyone can close it.
        vault.expireTrigger(triggerId);
    }
}
