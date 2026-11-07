// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Gate 2 trend and spike cap at the exact edge: P1 = P0 * (1 + threshold) buys, 1 wei less does not; P1 =
/// P0 * (1 + cap) buys, 1 wei more does not. The base rule has a 3% threshold and a 12% cap.
contract TrendBoundariesTest is UnitBase {
    uint256 triggerId;
    uint256 t0;

    function setUp() public override {
        super.setUp();
        (triggerId, t0) = openEthTriggerNow("2000");
        vm.warp(t0 + 31 minutes);
    }

    // P0 = 2000, so the threshold is 2000 * 1.03 = 2060 and the cap is 2000 * 1.12 = 2240.

    function test_ConfirmTrigger_BuysAtExactlyTheThreshold() public {
        uint256 positionId = vault.confirmTrigger(triggerId, signedPrice("2060.000000000000000000"));

        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
        assertEq(vault.getPosition(positionId).entryPrice, 2060e18);
    }

    function test_RevertWhen_P1IsOneWeiBelowTheThreshold() public {
        bytes[] memory p1 = signedPrice("2059.99999999");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2059999999990000000000));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysAtExactlyTheSpikeCap() public {
        uint256 positionId = vault.confirmTrigger(triggerId, signedPrice("2240.000000000000000000"));

        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
        assertEq(vault.getPosition(positionId).entryPrice, 2240e18);
    }

    function test_RevertWhen_P1IsOneWeiAboveTheSpikeCap() public {
        bytes[] memory p1 = signedPrice("2240.00000001");

        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 2000e18, 2240000000010000000000));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_P1EqualsP0() public {
        bytes[] memory p1 = signedPrice("2000.000000000000000000");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2000e18));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_AFailedP1LeavesTheTriggerOpenAndTheBalanceUntouched() public {
        bytes[] memory p1 = signedPrice("2059.99999999");
        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2059999999990000000000));
        vault.confirmTrigger(triggerId, p1);

        assertStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(user), 1_000e6);
        assertEq(vault.spentToday(user, ETH), 0);
        assertEq(teth.balanceOf(address(vault)), 0);
    }
}

/// @notice The trend and cap edges when P0 * (1 + bps) is not a whole number of wei: the threshold rounds up and the
/// cap rounds down, so the vault never buys outside the exact real-number range
contract TrendRoundingBoundariesTest is UnitBase {
    uint256 triggerId;

    function setUp() public override {
        super.setUp();
        uint256 t0;
        // P0 = 2000e18 + 1 wei: threshold = 2060000000000000000001.03 wei, cap = 2240000000000000000001.12 wei
        (triggerId, t0) = openEthTriggerNow("2000.00000001");
        vm.warp(t0 + 31 minutes);
    }

    function test_ConfirmTrigger_BuysAtTheThresholdRoundedUp() public {
        vault.confirmTrigger(triggerId, signedPrice("2060.00000002"));
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsTheThresholdRoundedDown() public {
        bytes[] memory p1 = signedPrice("2060.00000001");

        vm.expectRevert(
            abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000000000010000000000, 2060000000010000000000)
        );
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysAtTheSpikeCapRoundedDown() public {
        vault.confirmTrigger(triggerId, signedPrice("2240.00000001"));
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsTheSpikeCapRoundedUp() public {
        bytes[] memory p1 = signedPrice("2240.00000002");

        vm.expectRevert(
            abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 2000000000010000000000, 2240000000020000000000)
        );
        vault.confirmTrigger(triggerId, p1);
    }
}

/// @notice A rule stricter than the profile is enforced at its own edges: a 4.5% threshold and a 10% cap
contract StricterTrendBoundariesTest is UnitBase {
    uint256 triggerId;

    function setUp() public override {
        super.setUp();
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.thresholdBps = 450;
        assetRule.spikeCapBps = 1000;
        setUserEthRule(rule(), assetRule);
        uint256 t0;
        // Threshold 2000 * 1.045 = 2090, cap 2000 * 1.10 = 2200
        (triggerId, t0) = openEthTriggerNow("2000");
        vm.warp(t0 + 31 minutes);
    }

    function test_ConfirmTrigger_BuysAtExactlyTheRulesThreshold() public {
        vault.confirmTrigger(triggerId, signedPrice("2090.000000000000000000"));
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneWeiBelowTheRulesThreshold() public {
        // Above the profile's 3%, but below the rule's 4.5%
        bytes[] memory p1 = signedPrice("2089.99999999");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2089999999990000000000));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysAtExactlyTheRulesSpikeCap() public {
        vault.confirmTrigger(triggerId, signedPrice("2200.000000000000000000"));
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneWeiAboveTheRulesSpikeCap() public {
        // Below the profile's 12%, but above the rule's 10%
        bytes[] memory p1 = signedPrice("2200.00000001");

        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 2000e18, 2200000000010000000000));
        vault.confirmTrigger(triggerId, p1);
    }
}
