// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../src/interfaces/IVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice The tamper test: a P1 that is edited, old, for another asset or used twice is refused with the vault's named
/// error, and the trigger stays open. The same cases run against real Hermes payloads in test/fork/PythFork.t.sol.
contract TamperTest is VaultTestBase {
    uint256 internal triggerId;

    function setUp() public override {
        super.setUp();
        triggerId = openEthTrigger("2000");
        vm.warp(block.timestamp + 31 minutes);
    }

    function test_ValidRun_BuysAtThePythPrice() public {
        bytes[] memory p1 = signedPrice("2070");
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, p1);
        assertEq(vault.getPosition(positionId).entryPrice, 2070e18);
    }

    function test_RevertWhen_AValueIsEdited() public {
        bytes[] memory p1 = edited(signedPrice("2170"));
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheUpdateIsNoPriceAtAll() public {
        bytes[] memory junk = new bytes[](1);
        junk[0] = hex"504e4155deadbeef";
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.confirmTrigger(triggerId, junk);
    }

    function test_RevertWhen_ThePriceIsTooOld() public {
        uint256 publishedAt = block.timestamp - 5 minutes - 1;
        bytes[] memory p1 = signedPriceAt("2070", publishedAt);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, publishedAt));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ThePriceIsAcceptedAtExactlyTheMaximumAge() public {
        vm.warp(block.timestamp + 5 minutes);
        bytes[] memory p1 = signedPriceAt("2070", block.timestamp - 5 minutes);
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheUpdateIsForAnotherAsset() public {
        bytes[] memory btc = signedPriceOf(BTC_FEED, "80000", block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IVault.WrongPriceFeed.selector, ETH_FEED));
        vault.confirmTrigger(triggerId, btc);
    }

    function test_ReadsTheAssetsFeedFromAnUpdateOfSeveralFeeds() public {
        bytes[] memory both = joined(signedPriceOf(BTC_FEED, "80000", block.timestamp), signedPrice("2070"));
        uint256 positionId = vault.confirmTrigger(triggerId, both);
        assertEq(vault.getPosition(positionId).entryPrice, 2070e18);
    }

    function test_RevertWhen_TheP1IsReplayedOnAnotherTriggerOfTheUser() public {
        // A second post a minute after the first trigger's P0, with its own P0
        uint256 t0 = vault.getTrigger(triggerId).t0;
        vm.warp(t0 + 2 minutes);
        vm.prank(agent);
        uint256 second = openTriggerWith(user, ETH, signedTweet(t0 + 1 minutes), signedPriceAt("2001", t0 + 1 minutes));

        vm.warp(t0 + 33 minutes);
        bytes[] memory p1 = signedPrice("2070");
        vault.confirmTrigger(triggerId, p1);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceAlreadyUsed.selector, ETH, block.timestamp));
        vault.confirmTrigger(second, p1);
    }

    function test_RevertWhen_AP0IsReplayedAsAP1() public {
        // P0 was published at the trigger's t0, so as its own P1 it never passes the wait.
        uint256 t0 = vault.getTrigger(triggerId).t0;
        bytes[] memory p0Again = signedPriceAt("2000", t0);
        vm.warp(t0 + 4 minutes);
        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + 30 minutes));
        vault.confirmTrigger(triggerId, p0Again);
    }

    function test_RevertWhen_AnotherTriggersP0IsReplayedAsAP1() public {
        // A second trigger opened 31 minutes after the first: its P0 is late enough to pass the first trigger's wait and
        // high enough for its trend, but it is already used.
        uint256 t0 = vault.getTrigger(triggerId).t0;
        uint256 secondPostAt = block.timestamp;
        vm.warp(secondPostAt + 1);
        bytes[] memory secondP0 = signedPriceAt("2070", secondPostAt);
        vm.prank(agent);
        openTriggerWith(user, ETH, signedTweet(secondPostAt), secondP0);

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceAlreadyUsed.selector, ETH, secondPostAt));
        vault.confirmTrigger(triggerId, secondP0);
        assertGt(secondPostAt, t0 + 30 minutes);
    }

    function test_TheTriggerStaysOpenAfterARejection() public {
        bytes[] memory forged = edited(signedPrice("2170"));
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.confirmTrigger(triggerId, forged);
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Open));

        vault.confirmTrigger(triggerId, signedPrice("2070"));
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Confirmed));
    }
}
