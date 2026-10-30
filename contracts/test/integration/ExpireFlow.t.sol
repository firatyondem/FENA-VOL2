// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FixtureFlowBase} from "./utils/FixtureFlowBase.sol";

/// @notice Integration flow 3: a trigger whose window closes without a valid P1 expires, anyone can expire it, and no
/// token moves
contract ExpireFlowTest is FixtureFlowBase {
    uint256 constant DEPOSIT = 500e6;

    /// @dev tweet-trump-venezuela + eth-p0, then only eth-p1-late (15 min after P0, past the 10-minute window)
    function test_Expire_AnyoneExpiresAfterTheWindowAndNothingMoves() public {
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
        uint256 vaultUsdc = usdc.balanceOf(address(vault));
        uint256 usdcSupply = usdc.totalSupply();

        vm.warp(P0_SIGNED_AT);
        uint256 triggerId = openWithFixtures(alice, aliceAgent, ETH, "tweet-trump-venezuela", "eth-p0");
        uint256 deadline = T0 + 10 minutes;

        // At the last second of the window the trigger is not expired yet.
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(IVault.WindowNotClosed.selector, deadline));
        vm.prank(stranger);
        vault.expireTrigger(triggerId);

        // The only P1 that comes is past the window, so it cannot buy.
        vm.warp(P1_LATE_SIGNED_AT);
        IVault.SignedResponse memory late = fixture("eth-p1-late");
        vm.expectRevert(abi.encodeWithSelector(IVault.WindowClosed.selector, deadline));
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, late);

        // Anyone, here a stranger with no balance and no rule, expires it.
        vm.expectEmit(address(vault));
        emit IVault.TriggerExpired(triggerId);
        vm.prank(stranger);
        vault.expireTrigger(triggerId);

        IVault.Trigger memory trigger = vault.getTrigger(triggerId);
        assertEq(uint256(trigger.status), uint256(IVault.TriggerStatus.Expired));
        assertEq(trigger.user, alice);

        // Nothing moved.
        assertEq(vault.balanceOf(alice), DEPOSIT);
        assertEq(usdc.balanceOf(address(vault)), vaultUsdc);
        assertEq(usdc.balanceOf(address(dex)), 0);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.totalSupply(), usdcSupply);
        assertEq(teth.totalSupply(), 0);
        assertEq(vault.positionCount(), 0);
        assertEq(vault.spentToday(alice, ETH), 0);
        assertBooksBalance();

        // An expired trigger never buys and never expires twice.
        vm.expectRevert(abi.encodeWithSelector(IVault.TriggerNotOpen.selector, triggerId));
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, late);
        vm.expectRevert(abi.encodeWithSelector(IVault.TriggerNotOpen.selector, triggerId));
        vm.prank(stranger);
        vault.expireTrigger(triggerId);

        // Alice can still take her whole deposit out.
        vm.prank(alice);
        vault.withdraw(DEPOSIT);
        assertEq(usdc.balanceOf(alice), DEPOSIT);
        assertBooksBalance();
    }
}
