// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Gate 2 window at the exact edge: t1 - t0 = minWait and = maxWindow buy, minWait - 1 s and maxWindow + 1 s
/// do not; a trigger expires only after t0 + maxWindow. The base rule waits 30 min and closes after 4 h.
contract WindowBoundariesTest is UnitBase {
    uint256 triggerId;
    uint256 t0;

    function setUp() public override {
        super.setUp();
        (triggerId, t0) = openEthTriggerNow("2000");
    }

    function test_ConfirmTrigger_BuysAtExactlyTheMinimumWait() public {
        confirmAt(triggerId, t0 + 30 minutes, "2070");
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneSecondBeforeTheMinimumWait() public {
        vm.warp(t0 + 30 minutes - 1);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + 30 minutes));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysAtExactlyTheMaximumWindow() public {
        confirmAt(triggerId, t0 + 4 hours, "2070");
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneSecondAfterTheMaximumWindow() public {
        vm.warp(t0 + 4 hours + 1);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WindowClosed.selector, t0 + 4 hours));
        vault.confirmTrigger(triggerId, p1);
    }

    /// @dev The window is measured on the time the source took P1, not on the block time.
    function test_RevertWhen_P1WasTakenOneSecondBeforeTheMinimumWaitButSubmittedLater() public {
        vm.warp(t0 + 30 minutes + 1 minutes);
        IVault.SignedResponse memory p1 = signedPriceAt("2070", t0 + 30 minutes - 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + 30 minutes));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysWithAP1TakenAtTheMaximumWindowAndSubmittedLater() public {
        vm.warp(t0 + 4 hours + 1 minutes);
        IVault.SignedResponse memory p1 = signedPriceAt("2070", t0 + 4 hours);

        vault.confirmTrigger(triggerId, p1);
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_TheTriggerExpiresAtExactlyTheMaximumWindow() public {
        vm.warp(t0 + 4 hours);

        vm.expectRevert(abi.encodeWithSelector(IVault.WindowNotClosed.selector, t0 + 4 hours));
        vault.expireTrigger(triggerId);
    }

    function test_ExpireTrigger_ClosesOneSecondAfterTheMaximumWindow() public {
        vm.warp(t0 + 4 hours + 1);

        vm.prank(keeper);
        vault.expireTrigger(triggerId);
        assertStatus(triggerId, IVault.TriggerStatus.Expired);
        assertEq(vault.balanceOf(user), 1_000e6);
        assertEq(usdc.balanceOf(address(vault)), 1_000e6);
    }

    function test_RevertWhen_AnExpiredTriggerIsConfirmed() public {
        vm.warp(t0 + 4 hours + 1);
        vault.expireTrigger(triggerId);
        IVault.SignedResponse memory p1 = signedPriceAt("2070", t0 + 4 hours);

        vm.expectRevert(abi.encodeWithSelector(IVault.TriggerNotOpen.selector, triggerId));
        vault.confirmTrigger(triggerId, p1);
    }
}

/// @notice The window edges of a rule stricter than the profile: 45 min wait and a 2 h window
contract StricterWindowBoundariesTest is UnitBase {
    uint256 triggerId;
    uint256 t0;

    function setUp() public override {
        super.setUp();
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.minWait = 45 minutes;
        assetRule.maxWindow = 2 hours;
        setUserEthRule(rule(), assetRule);
        (triggerId, t0) = openEthTriggerNow("2000");
    }

    function test_ConfirmTrigger_BuysAtExactlyTheRulesMinimumWait() public {
        confirmAt(triggerId, t0 + 45 minutes, "2070");
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneSecondBeforeTheRulesMinimumWait() public {
        vm.warp(t0 + 45 minutes - 1);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + 45 minutes));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysAtExactlyTheRulesMaximumWindow() public {
        confirmAt(triggerId, t0 + 2 hours, "2070");
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneSecondAfterTheRulesMaximumWindow() public {
        vm.warp(t0 + 2 hours + 1);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.WindowClosed.selector, t0 + 2 hours));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ExpireTrigger_UsesTheRulesMaximumWindow() public {
        vm.warp(t0 + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(IVault.WindowNotClosed.selector, t0 + 2 hours));
        vault.expireTrigger(triggerId);

        vm.warp(t0 + 2 hours + 1);
        vault.expireTrigger(triggerId);
        assertStatus(triggerId, IVault.TriggerStatus.Expired);
    }
}
