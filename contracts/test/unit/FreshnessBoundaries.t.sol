// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Response age at the exact edge: a response signed exactly 5 min ago is accepted, 5 min + 1 s is not. Holds
/// for the post, P0, P1 and a sell price.
/// @dev The ETH profile here accepts a source price up to 1 h old, so only the response age can fail.
contract ResponseAgeBoundariesTest is UnitBase {
    function setUp() public override {
        super.setUp();
        IVault.AssetProfile memory profile = ethProfile();
        profile.maxPriceAge = 1 hours;
        vault.setAssetProfile(ETH, profile);
    }

    function test_OpenTrigger_AcceptsAPostSignedExactlyFiveMinutesAgo() public {
        uint256 signedAt = block.timestamp;
        IVault.SignedResponse memory tweet = signedTweetSignedAt(signedAt, signedAt);
        vm.warp(signedAt + 5 minutes);

        openWith(tweet, signedPrice("2000"));
        assertEq(vault.triggerCount(), 1);
    }

    function test_RevertWhen_ThePostWasSignedFiveMinutesAndOneSecondAgo() public {
        uint256 signedAt = block.timestamp;
        IVault.SignedResponse memory tweet = signedTweetSignedAt(signedAt, signedAt);
        vm.warp(signedAt + 5 minutes + 1);
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_OpenTrigger_AcceptsAP0SignedExactlyFiveMinutesAgo() public {
        uint256 signedAt = block.timestamp;
        IVault.SignedResponse memory p0 = signedPriceSignedAt("2000", signedAt, signedAt);
        vm.warp(signedAt + 5 minutes);

        openWith(signedTweetSignedAt(signedAt, block.timestamp), p0);
        assertEq(vault.triggerCount(), 1);
    }

    function test_RevertWhen_P0WasSignedFiveMinutesAndOneSecondAgo() public {
        uint256 signedAt = block.timestamp;
        IVault.SignedResponse memory p0 = signedPriceSignedAt("2000", signedAt, signedAt);
        vm.warp(signedAt + 5 minutes + 1);
        IVault.SignedResponse memory tweet = signedTweetSignedAt(signedAt, block.timestamp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_ConfirmTrigger_AcceptsAP1SignedExactlyFiveMinutesAgo() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        uint256 signedAt = t0 + 30 minutes;
        IVault.SignedResponse memory p1 = signedPriceSignedAt("2070", signedAt, signedAt);
        vm.warp(signedAt + 5 minutes);

        vault.confirmTrigger(triggerId, p1);
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1WasSignedFiveMinutesAndOneSecondAgo() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        uint256 signedAt = t0 + 30 minutes;
        IVault.SignedResponse memory p1 = signedPriceSignedAt("2070", signedAt, signedAt);
        vm.warp(signedAt + 5 minutes + 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_Sell_AcceptsAPriceSignedExactlyFiveMinutesAgo() public {
        uint256 positionId = buyEth();
        uint256 signedAt = block.timestamp + 10 minutes;
        IVault.SignedResponse memory price = signedPriceSignedAt("2070", signedAt, signedAt);
        vm.warp(signedAt + 5 minutes);

        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheSellPriceWasSignedFiveMinutesAndOneSecondAgo() public {
        uint256 positionId = buyEth();
        uint256 signedAt = block.timestamp + 10 minutes;
        IVault.SignedResponse memory price = signedPriceSignedAt("2070", signedAt, signedAt);
        vm.warp(signedAt + 5 minutes + 1);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }
}

/// @notice Post to P0 at the exact edge: P0 taken exactly 10 min after the post opens a trigger, 10 min + 1 s does
/// not, and a P0 taken before the post does not
contract TweetToP0BoundariesTest is UnitBase {
    uint256 postedAt;

    function setUp() public override {
        super.setUp();
        postedAt = block.timestamp;
    }

    function test_OpenTrigger_AcceptsAP0TakenExactlyTenMinutesAfterThePost() public {
        vm.warp(postedAt + 10 minutes);

        uint256 triggerId = openWith(signedTweet(postedAt), signedPrice("2000"));
        assertEq(vault.getTrigger(triggerId).t0, postedAt + 10 minutes);
    }

    function test_RevertWhen_P0IsTakenTenMinutesAndOneSecondAfterThePost() public {
        vm.warp(postedAt + 10 minutes + 1);
        IVault.SignedResponse memory tweet = signedTweet(postedAt);
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, postedAt + 10 minutes + 1)
        );
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_OpenTrigger_AcceptsAP0TakenAtTheSecondOfThePost() public {
        vm.warp(postedAt + 1 minutes);

        uint256 triggerId = openWith(signedTweet(postedAt), signedPriceAt("2000", postedAt));
        assertEq(vault.getTrigger(triggerId).t0, postedAt);
    }

    function test_RevertWhen_P0IsTakenOneSecondBeforeThePost() public {
        vm.warp(postedAt + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(postedAt);
        IVault.SignedResponse memory p0 = signedPriceAt("2000", postedAt - 1);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, postedAt - 1));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    /// @dev A rejected P0 does not burn the post: the agent can retry with a P0 inside the window.
    function test_ARejectedP0LeavesThePostUsable() public {
        vm.warp(postedAt + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(postedAt);
        IVault.SignedResponse memory early = signedPriceAt("2000", postedAt - 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, postedAt - 1));
        vault.openTrigger(user, ETH, tweet, early);

        openWith(tweet, signedPrice("2000"));
        assertEq(vault.triggerCount(), 1);
    }
}

/// @notice Market hours at the exact edge: a source price exactly maxPriceAge old is accepted, 1 s older is not. Holds
/// for P0, P1 and a sell price, and for the age that the asset's profile sets.
contract MarketHoursBoundariesTest is UnitBase {
    function test_OpenTrigger_AcceptsAP0ExactlyMaxPriceAgeOld() public {
        vm.warp(block.timestamp + 1 hours);
        uint256 takenAt = block.timestamp - 5 minutes;

        uint256 triggerId = openWith(signedTweet(takenAt), signedPriceAt("2000", takenAt));
        assertEq(vault.getTrigger(triggerId).t0, takenAt);
    }

    function test_RevertWhen_P0IsOneSecondOlderThanMaxPriceAge() public {
        vm.warp(block.timestamp + 1 hours);
        uint256 takenAt = block.timestamp - 5 minutes - 1;
        IVault.SignedResponse memory tweet = signedTweet(takenAt);
        IVault.SignedResponse memory p0 = signedPriceAt("2000", takenAt);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, takenAt));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_ConfirmTrigger_AcceptsAP1ExactlyMaxPriceAgeOld() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        uint256 takenAt = t0 + 40 minutes;
        vm.warp(takenAt + 5 minutes);

        vault.confirmTrigger(triggerId, signedPriceAt("2070", takenAt));
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneSecondOlderThanMaxPriceAge() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        uint256 takenAt = t0 + 40 minutes;
        vm.warp(takenAt + 5 minutes + 1);
        IVault.SignedResponse memory p1 = signedPriceAt("2070", takenAt);

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, takenAt));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_Sell_AcceptsAPriceExactlyMaxPriceAgeOld() public {
        uint256 positionId = buyEth();
        uint256 takenAt = block.timestamp + 10 minutes;
        vm.warp(takenAt + 5 minutes);

        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, signedPriceAt("2070", takenAt));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheSellPriceIsOneSecondOlderThanMaxPriceAge() public {
        uint256 positionId = buyEth();
        uint256 takenAt = block.timestamp + 10 minutes;
        vm.warp(takenAt + 5 minutes + 1);
        IVault.SignedResponse memory price = signedPriceAt("2070", takenAt);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, takenAt));
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_OpenTrigger_UsesTheProfilesMaxPriceAge() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.maxPriceAge = 2 minutes;
        vault.setAssetProfile(ETH, profile);
        vm.warp(block.timestamp + 1 hours);

        uint256 tooOld = block.timestamp - 2 minutes - 1;
        IVault.SignedResponse memory tweet = signedTweet(tooOld);
        IVault.SignedResponse memory stale = signedPriceAt("2000", tooOld);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, tooOld));
        vault.openTrigger(user, ETH, tweet, stale);

        uint256 justInTime = block.timestamp - 2 minutes;
        openWith(tweet, signedPriceAt("2000", justInTime));
        assertEq(vault.triggerCount(), 1);
    }

    /// @dev A source that writes "updatedAt" in seconds, for a profile with updatedAtInMs off
    function test_OpenTrigger_ReadsUpdatedAtInSecondsAtTheSameEdge() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.updatedAtInMs = false;
        vault.setAssetProfile(ETH, profile);
        vm.warp(block.timestamp + 1 hours);

        uint256 tooOld = block.timestamp - 5 minutes - 1;
        IVault.SignedResponse memory tweet = signedTweet(tooOld);
        IVault.SignedResponse memory stale = sign(
            priceAirnodeKey,
            ETH_PRICE_REQUEST,
            block.timestamp,
            bytes(string.concat('{"price":2000,"updatedAt":', vm.toString(tooOld), "}"))
        );
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, tooOld));
        vault.openTrigger(user, ETH, tweet, stale);

        uint256 justInTime = block.timestamp - 5 minutes;
        IVault.SignedResponse memory fresh = sign(
            priceAirnodeKey,
            ETH_PRICE_REQUEST,
            block.timestamp,
            bytes(string.concat('{"price":2000,"updatedAt":', vm.toString(justInTime), "}"))
        );
        uint256 triggerId = openWith(tweet, fresh);
        assertEq(vault.getTrigger(triggerId).t0, justInTime);
    }
}
