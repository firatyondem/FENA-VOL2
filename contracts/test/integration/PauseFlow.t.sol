// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FixtureFlowBase} from "./utils/FixtureFlowBase.sol";

/// @notice Integration flow 6: the user pauses in the middle of a flow. Nothing opens or confirms while paused, the
/// withdrawal still works, and after the user resumes a new trigger buys
/// @dev Posts and prices are signed now by the manifest's fixture Airnode.
contract PauseFlowTest is FixtureFlowBase {
    uint256 constant DEPOSIT = 500e6;
    uint256 constant BUY = 50e6;

    function setUp() public override {
        super.setUp();
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
    }

    function test_Pause_BlocksOpeningAndConfirmingButNotWithdrawalAndANewTriggerBuysAfterResuming() public {
        // An open trigger waits for its P1.
        IVault.SignedResponse memory post = freshTrumpPost();
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
        IVault.SignedResponse memory p1 = fixtureSignedPrice(ethRequest, "2070");
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, alice));
        vm.prank(keeper);
        vault.confirmTrigger(oldTrigger, p1);
        assertEq(uint256(vault.getTrigger(oldTrigger).status), uint256(IVault.TriggerStatus.Open));
        assertEq(vault.balanceOf(alice), DEPOSIT, "nothing moved");

        // The agent cannot open a new trigger either.
        IVault.SignedResponse memory newPost = freshTrumpPost();
        vm.warp(block.timestamp + 1 minutes);
        IVault.SignedResponse memory newP0 = fixtureSignedPrice(ethRequest, "2000");
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, alice));
        vm.prank(aliceAgent);
        vault.openTrigger(alice, ETH, newPost, newP0);

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
        p1 = fixtureSignedPrice(ethRequest, "2070");
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(newTrigger, p1);

        assertTrue(vault.getPosition(positionId).isOpen);
        assertEq(vault.getPosition(positionId).cost, BUY);
        assertEq(vault.balanceOf(alice), DEPOSIT - 200e6 - BUY);
        assertBooksBalance();
    }

    /// @dev A post of Trump that was created now and signed now by the fixture Airnode
    function freshTrumpPost() internal view returns (IVault.SignedResponse memory) {
        bytes memory data = bytes(string.concat('{"id":"', vm.toString(tweetIdAt(block.timestamp)), '"}'));
        return sign(fixtureAirnodeKey, trumpAccount, block.timestamp, data);
    }

    /// @dev The agent opens an ETH trigger with `post` and an ETH price of `p0` taken now
    function openFrom(IVault.SignedResponse memory post, string memory p0) internal returns (uint256) {
        IVault.SignedResponse memory price = fixtureSignedPrice(ethRequest, p0);
        vm.prank(aliceAgent);
        return vault.openTrigger(alice, ETH, post, price);
    }
}
