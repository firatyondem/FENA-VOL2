// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVault} from "../src/interfaces/IVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice Balances, the rule and the asset profiles
contract VaultTest is VaultTestBase {
    function test_Deposit_AddsToTheBalance() public {
        usdc.mint(user, 5e6);
        vm.prank(user);
        vault.deposit(5e6);
        assertEq(vault.balanceOf(user), 1_005e6);
        assertEq(usdc.balanceOf(address(vault)), 1_005e6);
    }

    function test_Withdraw_WorksWhilePaused() public {
        vm.startPrank(user);
        vault.setPaused(true);
        vault.withdraw(400e6);
        vm.stopPrank();
        assertEq(vault.balanceOf(user), 600e6);
        assertEq(usdc.balanceOf(user), 400e6);
    }

    function test_RevertWhen_WithdrawingMoreThanTheBalance() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientBalance.selector, 1_000e6, 1_001e6));
        vault.withdraw(1_001e6);
    }

    function test_RevertWhen_DepositingZero() public {
        vm.prank(user);
        vm.expectRevert(IVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_SetRule_StoresTheRule() public view {
        (IVault.Rule memory stored, bytes32[] memory assetIds, bytes32[] memory accounts) = vault.getRule(user);
        assertEq(stored.agent, agent);
        assertEq(stored.buyAmount, 50e6);
        assertEq(assetIds.length, 1);
        assertEq(assetIds[0], ETH);
        assertEq(accounts[0], ACCOUNT);
        (bool isAllowed, IVault.AssetRule memory assetRule) = vault.getAssetRule(user, ETH);
        assertTrue(isAllowed);
        assertEq(assetRule.thresholdBps, 300);
    }

    function test_SetRule_AcceptsAStricterRule() public {
        IVault.AssetRule memory stricter = ethRule();
        stricter.thresholdBps = 500;
        stricter.spikeCapBps = 1000;
        stricter.minWait = 1 hours;
        stricter.maxWindow = 2 hours;
        vm.prank(user);
        setEthRule(stricter);
        (, IVault.AssetRule memory stored) = vault.getAssetRule(user, ETH);
        assertEq(stored.thresholdBps, 500);
    }

    function test_RevertWhen_TheRuleIsLooserThanTheProfile() public {
        IVault.AssetRule[4] memory looser = [ethRule(), ethRule(), ethRule(), ethRule()];
        looser[0].thresholdBps = 299;
        looser[1].spikeCapBps = 1201;
        looser[2].minWait = 29 minutes;
        looser[3].maxWindow = 4 hours + 1;
        for (uint256 i; i < looser.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(IVault.RuleLooserThanProfile.selector, ETH));
            this.setEthRuleAs(user, looser[i]);
        }
    }

    function test_RevertWhen_TheBudgetSharesAddUpToMoreThan100Percent() public {
        vault.setAssetProfile(OIL, oilProfile());
        IVault.AssetRule memory eth = ethRule();
        eth.budgetShareBps = 6_000;
        IVault.AssetRule memory oil = oilRule();
        oil.budgetShareBps = 5_000;

        vm.prank(user);
        vm.expectRevert(IVault.InvalidRule.selector);
        vault.setRule(rule(), twoAssets(), twoRules(eth, oil), topics(2), watched());
    }

    function test_RevertWhen_TheBuyAmountIsAboveTheMaxPerTrade() public {
        IVault.Rule memory invalid = rule();
        invalid.buyAmount = 51e6;
        bytes32[] memory assetIds = new bytes32[](1);
        assetIds[0] = ETH;
        IVault.AssetRule[] memory assetRules = new IVault.AssetRule[](1);
        assetRules[0] = ethRule();

        vm.prank(user);
        vm.expectRevert(IVault.InvalidRule.selector);
        vault.setRule(invalid, assetIds, assetRules, topics(1), watched());
    }

    function test_RevertWhen_TheAccountIsNotRegistered() public {
        bytes32[] memory accounts = new bytes32[](1);
        accounts[0] = keccak256("unknown account");
        bytes32[] memory assetIds = new bytes32[](1);
        assetIds[0] = ETH;
        IVault.AssetRule[] memory assetRules = new IVault.AssetRule[](1);
        assetRules[0] = ethRule();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.AccountNotRegistered.selector, accounts[0]));
        vault.setRule(rule(), assetIds, assetRules, topics(1), accounts);
    }

    function test_SetRule_ReplacesThePreviousAssets() public {
        vault.setAssetProfile(OIL, oilProfile());
        bytes32[] memory assetIds = new bytes32[](1);
        assetIds[0] = OIL;
        IVault.AssetRule[] memory assetRules = new IVault.AssetRule[](1);
        assetRules[0] = oilRule();

        vm.prank(user);
        vault.setRule(rule(), assetIds, assetRules, topics(1), watched());

        (bool isEthAllowed,) = vault.getAssetRule(user, ETH);
        (bool isOilAllowed,) = vault.getAssetRule(user, OIL);
        assertFalse(isEthAllowed);
        assertTrue(isOilAllowed);
    }

    function test_SetRule_EmitsTheTopicsForTheAgent() public {
        bytes32[] memory assetIds = new bytes32[](1);
        assetIds[0] = ETH;
        IVault.AssetRule[] memory assetRules = new IVault.AssetRule[](1);
        assetRules[0] = ethRule();
        string[] memory assetTopics = new string[](1);
        assetTopics[0] = "tariffs,crypto reserve";

        vm.expectEmit(address(vault));
        emit IVault.RuleSet(user, rule(), assetIds, assetRules, assetTopics, watched());
        vm.prank(user);
        vault.setRule(rule(), assetIds, assetRules, assetTopics, watched());
    }

    function test_RevertWhen_TheTopicsDoNotMatchTheAssets() public {
        bytes32[] memory assetIds = new bytes32[](1);
        assetIds[0] = ETH;
        IVault.AssetRule[] memory assetRules = new IVault.AssetRule[](1);
        assetRules[0] = ethRule();

        vm.prank(user);
        vm.expectRevert(IVault.InvalidRule.selector);
        vault.setRule(rule(), assetIds, assetRules, topics(2), watched());
    }

    function test_RevertWhen_AProfileLetsTheAgentBuyWithoutATrend() public {
        // Without a wait or a threshold, a P1 could equal P0, so the agent's say alone would buy.
        IVault.AssetProfile memory noWait = oilProfile();
        noWait.minWait = 0;
        vm.expectRevert(IVault.InvalidRule.selector);
        vault.setAssetProfile(OIL, noWait);

        IVault.AssetProfile memory noThreshold = oilProfile();
        noThreshold.minThresholdBps = 0;
        vm.expectRevert(IVault.InvalidRule.selector);
        vault.setAssetProfile(OIL, noThreshold);
    }

    function test_RevertWhen_SomeoneElseSetsAProfile() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vault.setAssetProfile(OIL, oilProfile());
    }

    function setEthRuleAs(address caller, IVault.AssetRule memory assetRule) external {
        vm.prank(caller);
        setEthRule(assetRule);
    }

    // Crude oil row of the asset profiles: +1.5% threshold, 5% spike cap, 1 h -> 6 h
    function oilProfile() internal view returns (IVault.AssetProfile memory) {
        return IVault.AssetProfile({
            token: address(toil),
            airnode: priceAirnode,
            priceRequestHash: OIL_PRICE_REQUEST,
            minThresholdBps: 150,
            maxSpikeCapBps: 500,
            minWait: 1 hours,
            maxWindow: 6 hours,
            maxPriceAge: 5 minutes,
            updatedAtInMs: true
        });
    }

    function oilRule() internal pure returns (IVault.AssetRule memory) {
        return IVault.AssetRule({
            thresholdBps: 150,
            spikeCapBps: 500,
            minWait: 1 hours,
            maxWindow: 6 hours,
            cooldown: 24 hours,
            budgetShareBps: 5_000,
            takeProfitBps: 800,
            stagnationBandBps: 100,
            stagnationDelay: 24 hours
        });
    }

    function twoAssets() internal pure returns (bytes32[] memory assetIds) {
        assetIds = new bytes32[](2);
        assetIds[0] = ETH;
        assetIds[1] = OIL;
    }

    function twoRules(IVault.AssetRule memory first, IVault.AssetRule memory second)
        internal
        pure
        returns (IVault.AssetRule[] memory assetRules)
    {
        assetRules = new IVault.AssetRule[](2);
        assetRules[0] = first;
        assetRules[1] = second;
    }
}
