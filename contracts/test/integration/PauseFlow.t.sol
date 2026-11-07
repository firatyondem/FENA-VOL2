// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FixtureFlowBase} from "./utils/FixtureFlowBase.sol";

/// @notice Integration flow 6: the user pauses in the middle of a flow. Nothing opens or confirms while paused, the
/// withdrawal still works, and after the user resumes a new trigger buys
/// @dev Posts are created and prices published as the flow goes.
contract PauseFlowTest is FixtureFlowBase {
    uint256 constant DEPOSIT = 500e6;
    uint256 constant BUY = 50e6;

    function setUp() public override {
        super.setUp();
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
    }

    function test_Pause_BlocksOpeningAndConfirmingButNotWithdrawalAndANewTriggerBuysAfterResuming() public {
        // An open trigger waits for its P1.
        Post memory post = freshTrumpPost();
        vm.warp(block.timestamp + 1 minutes);
        uint256 oldTrigger = openFrom(post, "2000");
        uint256 t0 = block.timestamp;

        // The user pauses.
        vm.expectEmit(address(vault));
        emit IVault.PausedSet(alice, true);
        vm.prank(alice);
        vault.setPaused(true);
        assertTrue(vault.isPaused(alice));

        // The valid P1 arrives, but a paused rule does not buy, and the trigger stays open.
        vm.warp(t0 + 5 minutes);
        bytes[] memory p1 = fixtureSignedPrice(ETH_FEED, "2070");
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, alice));
        vm.prank(keeper);
        vault.confirmTrigger(oldTrigger, p1);
        assertEq(uint256(vault.getTrigger(oldTrigger).status), uint256(IVault.TriggerStatus.Open));
        assertEq(vault.balanceOf(alice), DEPOSIT, "nothing moved");

        // The agent cannot open a new trigger either.
        Post memory newPost = freshTrumpPost();
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory newP0 = fixtureSignedPrice(ETH_FEED, "2000");
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, alice));
        vm.prank(aliceAgent);
        openTriggerWith(alice, ETH, newPost, newP0);

        // The withdrawal works while paused.
        uint256 walletBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(200e6);
        assertEq(usdc.balanceOf(alice), walletBefore + 200e6, "wallet");
        assertEq(vault.balanceOf(alice), DEPOSIT - 200e6, "vault balance");
        assertBooksBalance();

        // The user resumes. The old trigger's window is over by now, so anyone expires it.
        vm.prank(alice);
        vault.setPaused(false);
        assertFalse(vault.isPaused(alice));
        vm.warp(t0 + 10 minutes + 1);
        vault.expireTrigger(oldTrigger);
        assertEq(uint256(vault.getTrigger(oldTrigger).status), uint256(IVault.TriggerStatus.Expired));

        // A new trigger works again and buys.
        post = freshTrumpPost();
        vm.warp(block.timestamp + 1 minutes);
        uint256 newTrigger = openFrom(post, "2000");
        vm.warp(block.timestamp + 5 minutes);
        p1 = fixtureSignedPrice(ETH_FEED, "2070");
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(newTrigger, p1);

        assertTrue(vault.getPosition(positionId).isOpen);
        assertEq(vault.getPosition(positionId).cost, BUY);
        assertEq(vault.balanceOf(alice), DEPOSIT - 200e6 - BUY);
        assertBooksBalance();
    }

    /// @dev A post of Trump created now
    function freshTrumpPost() internal view returns (Post memory) {
        return postOf(trumpAccount, tweetIdAt(block.timestamp));
    }

    /// @dev The agent opens an ETH trigger with `post` and an ETH price of `p0` taken now
    function openFrom(Post memory post, string memory p0) internal returns (uint256) {
        bytes[] memory price = fixtureSignedPrice(ETH_FEED, p0);
        vm.prank(aliceAgent);
        return openTriggerWith(alice, ETH, post, price);
    }
}
