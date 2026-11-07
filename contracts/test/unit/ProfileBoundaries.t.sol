// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice A rule can make the asset profile stricter, never looser: for each of thresholdBps, spikeCapBps, minWait and
/// maxWindow the profile's own value and a stricter one pass, and one unit looser reverts RuleLooserThanProfile
/// @dev The ETH profile: 3% threshold, 12% cap, 30 min wait, 4 h window
contract ProfileBoundariesTest is UnitBase {
    // Threshold: a rule may ask for more rise, never less

    function test_SetRule_AcceptsTheProfilesThreshold() public {
        setEthRuleField(Field.Threshold, 300);
        assertEq(storedEthRule().thresholdBps, 300);
    }

    function test_SetRule_AcceptsAStricterThreshold() public {
        setEthRuleField(Field.Threshold, 301);
        assertEq(storedEthRule().thresholdBps, 301);
    }

    function test_RevertWhen_TheThresholdIsOneBasisPointLooser() public {
        expectLooser(Field.Threshold, 299);
    }

    // Spike cap: a rule may allow less spike, never more

    function test_SetRule_AcceptsTheProfilesSpikeCap() public {
        setEthRuleField(Field.SpikeCap, 1200);
        assertEq(storedEthRule().spikeCapBps, 1200);
    }

    function test_SetRule_AcceptsAStricterSpikeCap() public {
        setEthRuleField(Field.SpikeCap, 1199);
        assertEq(storedEthRule().spikeCapBps, 1199);
    }

    function test_RevertWhen_TheSpikeCapIsOneBasisPointLooser() public {
        expectLooser(Field.SpikeCap, 1201);
    }

    // Minimum wait: a rule may wait longer, never shorter

    function test_SetRule_AcceptsTheProfilesMinimumWait() public {
        setEthRuleField(Field.MinWait, 30 minutes);
        assertEq(storedEthRule().minWait, 30 minutes);
    }

    function test_SetRule_AcceptsAStricterMinimumWait() public {
        setEthRuleField(Field.MinWait, 30 minutes + 1);
        assertEq(storedEthRule().minWait, 30 minutes + 1);
    }

    function test_RevertWhen_TheMinimumWaitIsOneSecondLooser() public {
        expectLooser(Field.MinWait, 30 minutes - 1);
    }

    // Maximum window: a rule may close sooner, never later

    function test_SetRule_AcceptsTheProfilesMaximumWindow() public {
        setEthRuleField(Field.MaxWindow, 4 hours);
        assertEq(storedEthRule().maxWindow, 4 hours);
    }

    function test_SetRule_AcceptsAStricterMaximumWindow() public {
        setEthRuleField(Field.MaxWindow, 4 hours - 1);
        assertEq(storedEthRule().maxWindow, 4 hours - 1);
    }

    function test_RevertWhen_TheMaximumWindowIsOneSecondLooser() public {
        expectLooser(Field.MaxWindow, 4 hours + 1);
    }

    // A profile that the admin tightens after the rule was set binds the rule at Gate 2.

    function test_RevertWhen_TheAdminTightensTheProfileBeforeConfirmation() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        IVault.AssetProfile memory profile = ethProfile();
        profile.minThresholdBps = 301;
        vault.setAssetProfile(ETH, profile);
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleLooserThanProfile.selector, ETH));
        vault.confirmTrigger(triggerId, p1);
    }

    enum Field {
        Threshold,
        SpikeCap,
        MinWait,
        MaxWindow
    }

    function ethRuleWith(Field field, uint32 value) private pure returns (IVault.AssetRule memory assetRule) {
        assetRule = ethRule();
        if (field == Field.Threshold) assetRule.thresholdBps = uint16(value);
        else if (field == Field.SpikeCap) assetRule.spikeCapBps = uint16(value);
        else if (field == Field.MinWait) assetRule.minWait = value;
        else assetRule.maxWindow = value;
    }

    function setEthRuleField(Field field, uint32 value) private {
        setUserEthRule(rule(), ethRuleWith(field, value));
    }

    function expectLooser(Field field, uint32 value) private {
        IVault.AssetRule memory assetRule = ethRuleWith(field, value);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleLooserThanProfile.selector, ETH));
        vault.setRule(rule(), one(ETH), oneRule(assetRule), topics(1), watched());
    }

    function storedEthRule() private view returns (IVault.AssetRule memory assetRule) {
        bool isAllowed;
        (isAllowed, assetRule) = vault.getAssetRule(user, ETH);
        assertTrue(isAllowed);
    }
}

/// @notice Gate 2 checks the rule against the profile again, so a profile that the admin tightens after the rule was set
/// binds an open trigger. For each field, a profile tightened to exactly the rule still buys, and one unit tighter
/// reverts RuleLooserThanProfile with nothing spent.
/// @dev The rule is stricter than the ETH profile in every field: 4.5% threshold, 10% cap, 45 min wait, 2 h window. P1 =
/// 2100 at t0 + 50 min passes every check of that rule.
contract ProfileTighteningBoundariesTest is UnitBase {
    uint256 triggerId;
    uint256 t0;

    function setUp() public override {
        super.setUp();
        setUserEthRule(rule(), strictRule());
        (triggerId, t0) = openEthTriggerNow("2000");
    }

    function test_ConfirmTrigger_BuysWhenTheProfileIsTightenedToExactlyTheRule() public {
        vault.setAssetProfile(ETH, profileAtTheRule());

        confirmAt(triggerId, t0 + 50 minutes, "2100");
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
        assertEq(vault.spentToday(user, ETH), 50e6);
    }

    function test_RevertWhen_TheProfilesThresholdIsTightenedOneBasisPointPastTheRule() public {
        IVault.AssetProfile memory profile = profileAtTheRule();
        profile.minThresholdBps = 451;
        expectLooserAtGateTwo(profile);
    }

    function test_RevertWhen_TheProfilesSpikeCapIsTightenedOneBasisPointPastTheRule() public {
        IVault.AssetProfile memory profile = profileAtTheRule();
        profile.maxSpikeCapBps = 999;
        expectLooserAtGateTwo(profile);
    }

    function test_RevertWhen_TheProfilesMinimumWaitIsTightenedOneSecondPastTheRule() public {
        IVault.AssetProfile memory profile = profileAtTheRule();
        profile.minWait = 45 minutes + 1;
        expectLooserAtGateTwo(profile);
    }

    function test_RevertWhen_TheProfilesMaximumWindowIsTightenedOneSecondPastTheRule() public {
        IVault.AssetProfile memory profile = profileAtTheRule();
        profile.maxWindow = 2 hours - 1;
        expectLooserAtGateTwo(profile);
    }

    function strictRule() private pure returns (IVault.AssetRule memory assetRule) {
        assetRule = ethRule();
        assetRule.thresholdBps = 450;
        assetRule.spikeCapBps = 1000;
        assetRule.minWait = 45 minutes;
        assetRule.maxWindow = 2 hours;
    }

    function profileAtTheRule() private view returns (IVault.AssetProfile memory profile) {
        profile = ethProfile();
        profile.minThresholdBps = 450;
        profile.maxSpikeCapBps = 1000;
        profile.minWait = 45 minutes;
        profile.maxWindow = 2 hours;
    }

    function expectLooserAtGateTwo(IVault.AssetProfile memory profile) private {
        vault.setAssetProfile(ETH, profile);
        vm.warp(t0 + 50 minutes);
        bytes[] memory p1 = signedPrice("2100");

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleLooserThanProfile.selector, ETH));
        vault.confirmTrigger(triggerId, p1);
        assertStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(user), 1_000e6);
        assertEq(vault.spentToday(user, ETH), 0);
    }
}

/// @notice The lowest profile that setAssetProfile accepts (1 bps threshold, 1 s wait) still makes P1 come later and
/// higher than P0, and a rule cannot go below it to zero
contract LowestProfileBoundariesTest is UnitBase {
    function setUp() public override {
        super.setUp();
        IVault.AssetProfile memory profile = ethProfile();
        profile.minThresholdBps = 1;
        profile.minWait = 1;
        vault.setAssetProfile(ETH, profile);
    }

    function test_RevertWhen_TheRulesThresholdIsZero() public {
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.thresholdBps = 0;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleLooserThanProfile.selector, ETH));
        vault.setRule(rule(), one(ETH), oneRule(assetRule), topics(1), watched());
    }

    function test_RevertWhen_TheRulesMinimumWaitIsZero() public {
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.minWait = 0;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.RuleLooserThanProfile.selector, ETH));
        vault.setRule(rule(), one(ETH), oneRule(assetRule), topics(1), watched());
    }

    /// @dev 1 bps of 2000 is 0.2, so P1 = 2000.2 is the lowest that buys and P1 = P0 is refused.
    function test_ConfirmTrigger_BuysAtOneBasisPointAboveP0() public {
        setUserEthRule(rule(), lowestRule());
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");

        confirmAt(triggerId, t0 + 1, "2000.2");
        assertStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_P1IsOneWeiBelowTheLowestThreshold() public {
        setUserEthRule(rule(), lowestRule());
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        vm.warp(t0 + 1);
        bytes[] memory p1 = signedPrice("2000.19999999");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2000199999990000000000));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_P1EqualsP0UnderTheLowestThreshold() public {
        setUserEthRule(rule(), lowestRule());
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        vm.warp(t0 + 1);
        bytes[] memory p1 = signedPrice("2000.000000000000000000");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 2000e18, 2000e18));
        vault.confirmTrigger(triggerId, p1);
    }

    /// @dev With a 1 s wait, a P1 that the source took in the same second as P0 is refused.
    function test_RevertWhen_P1IsTakenInTheSameSecondAsP0() public {
        setUserEthRule(rule(), lowestRule());
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        bytes[] memory p1 = signedPrice("2000.2");

        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + 1));
        vault.confirmTrigger(triggerId, p1);
    }

    function lowestRule() private pure returns (IVault.AssetRule memory assetRule) {
        assetRule = ethRule();
        assetRule.thresholdBps = 1;
        assetRule.minWait = 1;
    }
}

/// @notice setAssetProfile refuses a zero minimum wait or a zero minimum threshold, so a P1 always has to come later and
/// higher than P0; the smallest non-zero values and the equal-bound edges pass
contract AssetProfileValidationTest is UnitBase {
    bytes32 constant NEW_ASSET = keccak256("NEW");

    function test_RevertWhen_TheProfilesMinimumWaitIsZero() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minWait = 0;

        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setAssetProfile(NEW_ASSET, profile);
    }

    function test_SetAssetProfile_AcceptsAOneSecondMinimumWait() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minWait = 1;

        vault.setAssetProfile(NEW_ASSET, profile);
        assertEq(vault.getAssetProfile(NEW_ASSET).minWait, 1);
    }

    function test_RevertWhen_TheProfilesMinimumThresholdIsZero() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minThresholdBps = 0;

        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setAssetProfile(NEW_ASSET, profile);
    }

    function test_SetAssetProfile_AcceptsAOneBasisPointMinimumThreshold() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minThresholdBps = 1;

        vault.setAssetProfile(NEW_ASSET, profile);
        assertEq(vault.getAssetProfile(NEW_ASSET).minThresholdBps, 1);
    }

    function test_SetAssetProfile_AcceptsAThresholdEqualToTheSpikeCap() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minThresholdBps = 1200;

        vault.setAssetProfile(NEW_ASSET, profile);
        assertEq(vault.getAssetProfile(NEW_ASSET).minThresholdBps, 1200);
    }

    function test_RevertWhen_TheProfilesThresholdIsAboveItsSpikeCap() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minThresholdBps = 1201;

        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setAssetProfile(NEW_ASSET, profile);
    }

    function test_SetAssetProfile_AcceptsAMinimumWaitEqualToTheWindow() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minWait = 4 hours;

        vault.setAssetProfile(NEW_ASSET, profile);
        assertEq(vault.getAssetProfile(NEW_ASSET).minWait, 4 hours);
    }

    function test_RevertWhen_TheProfilesMinimumWaitIsAboveItsWindow() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.minWait = 4 hours + 1;

        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setAssetProfile(NEW_ASSET, profile);
    }

    function test_RevertWhen_TheProfilesMaxPriceAgeIsZero() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.maxPriceAge = 0;

        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setAssetProfile(NEW_ASSET, profile);
    }

    /// @dev A rule's own threshold must not exceed its cap, and its wait must not exceed its window.
    function test_RevertWhen_TheRulesThresholdIsAboveItsSpikeCap() public {
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.thresholdBps = 1000;
        assetRule.spikeCapBps = 999;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setRule(rule(), one(ETH), oneRule(assetRule), topics(1), watched());
    }

    function test_RevertWhen_TheRulesMinimumWaitIsAboveItsWindow() public {
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.minWait = 2 hours + 1;
        assetRule.maxWindow = 2 hours;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setRule(rule(), one(ETH), oneRule(assetRule), topics(1), watched());
    }
}
