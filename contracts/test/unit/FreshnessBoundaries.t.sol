// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

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
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, postedAt + 10 minutes + 1)
        );
        openTriggerWith(user, ETH, tweet, p0);
    }

    function test_OpenTrigger_AcceptsAP0TakenAtTheSecondOfThePost() public {
        vm.warp(postedAt + 1 minutes);

        uint256 triggerId = openWith(signedTweet(postedAt), signedPriceAt("2000", postedAt));
        assertEq(vault.getTrigger(triggerId).t0, postedAt);
    }

    function test_RevertWhen_P0IsTakenOneSecondBeforeThePost() public {
        vm.warp(postedAt + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPriceAt("2000", postedAt - 1);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, postedAt - 1));
        openTriggerWith(user, ETH, tweet, p0);
    }

    /// @dev A rejected P0 does not burn the post: the agent can retry with a P0 inside the window.
    function test_ARejectedP0LeavesThePostUsable() public {
        vm.warp(postedAt + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory early = signedPriceAt("2000", postedAt - 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, postedAt - 1));
        openTriggerWith(user, ETH, tweet, early);

        openWith(tweet, signedPrice("2000"));
        assertEq(vault.triggerCount(), 1);
    }
}

/// @notice Market hours at the exact edge: a P1 or sell price exactly maxPriceAge old is accepted, 1 s older is not, for
/// the age that the asset's profile sets. P0 is bound to its post instead.
contract MarketHoursBoundariesTest is UnitBase {
    function test_OpenTrigger_AcceptsAP0OlderThanMaxPriceAgeForARecentPost() public {
        // P0 is the first price after the post, so the agent may bring it later, while the post is recent enough.
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 20 minutes);

        uint256 triggerId = openWith(signedTweet(postedAt), signedPriceAt("2000", postedAt + 1));
        assertEq(vault.getTrigger(triggerId).t0, postedAt + 1);
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
        bytes[] memory p1 = signedPriceAt("2070", takenAt);

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
        bytes[] memory price = signedPriceAt("2070", takenAt);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, takenAt));
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_ConfirmTrigger_UsesTheProfilesMaxPriceAge() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        IVault.AssetProfile memory profile = ethProfile();
        profile.maxPriceAge = 2 minutes;
        vault.setAssetProfile(ETH, profile);
        vm.warp(t0 + 1 hours);

        uint256 tooOld = block.timestamp - 2 minutes - 1;
        bytes[] memory stale = signedPriceAt("2070", tooOld);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, tooOld));
        vault.confirmTrigger(triggerId, stale);

        vault.confirmTrigger(triggerId, signedPriceAt("2070", block.timestamp - 2 minutes));
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }
}
