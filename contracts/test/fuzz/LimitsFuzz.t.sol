// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {FuzzBase} from "./FuzzBase.sol";

/// @notice The spending limits decide as the spec says for any amounts, budget shares, cooldowns and times: an asset
/// spends at most dailyLimit * share per UTC day, the budget resets at the next UTC midnight, and a second buy of an
/// asset waits for the cooldown
contract LimitsFuzzTest is FuzzBase {
    uint256 constant BUY = 50e6;
    uint256 constant DEPOSIT = 1_000e6;

    function setUp() public override {
        super.setUp();
        useWideEthProfile();
    }

    /// @notice Whether the first buy of the day goes through equals amount <= dailyLimit * share / 10_000
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_DailyBudgetDecisionEqualsTheFormula(uint256 dailyLimit, uint256 shareBps, uint256 amount) public {
        amount = bound(amount, 1, 100e6);
        dailyLimit = bound(dailyLimit, 0, 400e6);
        shareBps = bound(shareBps, 0, BPS);
        IVault.AssetRule memory assetRule = looseEthRule();
        assetRule.budgetShareBps = uint16(shareBps);
        setUserEthRule(userRuleOf(amount, dailyLimit), assetRule);

        uint256 budget = dailyLimit * shareBps / BPS;
        (uint256 triggerId, uint256 t0) = openEthAt(2000e18);
        vm.warp(t0 + 1);
        IVault.SignedResponse memory p1 = signedEthPrice(2070e18, block.timestamp);

        if (amount > budget) {
            vm.expectRevert(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, amount, budget));
            vm.prank(keeper);
            vault.confirmTrigger(triggerId, p1);
            assertEq(vault.balanceOf(user), DEPOSIT, "balance untouched");
            assertEq(vault.spentToday(user, ETH), 0, "nothing spent");
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        } else {
            vm.prank(keeper);
            vault.confirmTrigger(triggerId, p1);
            assertEq(vault.spentToday(user, ETH), amount, "spent");
            assertEq(vault.balanceOf(user), DEPOSIT - amount, "balance");
        }
    }

    /// @notice A second buy on the same UTC day goes through only while both fit in the budget, and the next UTC day
    /// starts with a fresh budget
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_SecondBuyOfTheDayStopsAtTheBudgetAndTheNextDayResetsIt(
        uint256 amount,
        uint256 shareBps,
        uint256 dailyLimit,
        uint256 gap
    ) public {
        amount = bound(amount, 1, BUY);
        shareBps = bound(shareBps, 1, BPS);
        // The smallest daily limit whose share still holds one buy, and up to four times that
        uint256 least = Math.ceilDiv(amount * BPS, shareBps);
        dailyLimit = bound(dailyLimit, least, 4 * least);
        gap = bound(gap, 0, 6 hours);
        setBudgetRule(amount, dailyLimit, shareBps);
        uint256 budget = dailyLimit * shareBps / BPS;
        uint256 day = block.timestamp / 1 days;

        // First buy
        confirmEthBuy();
        assertEq(vault.spentToday(user, ETH), amount, "first buy spent");

        // Second buy, later on the same UTC day
        vm.warp(block.timestamp + gap);
        (uint256 secondTrigger, IVault.SignedResponse memory secondP1) = readyEthBuy();
        assertEq(block.timestamp / 1 days, day, "still the same UTC day");
        if (2 * amount > budget) {
            vm.expectRevert(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, amount, budget - amount));
            vm.prank(keeper);
            vault.confirmTrigger(secondTrigger, secondP1);
            assertEq(vault.spentToday(user, ETH), amount, "second buy spent nothing");
            assertTriggerStatus(secondTrigger, IVault.TriggerStatus.Open);
        } else {
            vm.prank(keeper);
            vault.confirmTrigger(secondTrigger, secondP1);
            assertEq(vault.spentToday(user, ETH), 2 * amount, "second buy spent");
        }

        // The next UTC midnight resets the budget.
        vm.warp((day + 1) * 1 days);
        confirmEthBuy();
        assertEq(vault.spentToday(user, ETH), amount, "fresh budget on the next day");
    }

    /// @dev The user's rule: ETH only, `amount` per buy, `dailyLimit` per day of which ETH gets `shareBps`
    function setBudgetRule(uint256 amount, uint256 dailyLimit, uint256 shareBps) internal {
        IVault.AssetRule memory assetRule = looseEthRule();
        assetRule.budgetShareBps = uint16(shareBps);
        setUserEthRule(userRuleOf(amount, dailyLimit), assetRule);
    }

    /// @dev Opens a trigger at P0 = 2000 and returns it with a P1 of +3.5%, taken and signed one second after P0
    function readyEthBuy() internal returns (uint256 triggerId, IVault.SignedResponse memory p1) {
        uint256 t0;
        (triggerId, t0) = openEthAt(2000e18);
        vm.warp(t0 + 1);
        p1 = signedEthPrice(2070e18, block.timestamp);
    }

    /// @dev Opens a trigger and confirms it, expecting the buy to go through
    function confirmEthBuy() internal {
        (uint256 triggerId, IVault.SignedResponse memory p1) = readyEthBuy();
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, p1);
    }

    /// @notice A second buy of the asset waits until lastBuyAt + cooldown: it reverts with CooldownActive one second
    /// before, and buys exactly at the end of the cooldown
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_CooldownDecisionEqualsTheFormula(uint256 cooldown, uint256 offset, uint8 mode) public {
        // At least 62 s, so that the second P1 can come after the trigger's minimum wait of 1 s
        cooldown = bound(cooldown, 62, 6 hours);
        IVault.AssetRule memory assetRule = looseEthRule();
        assetRule.cooldown = uint32(cooldown);
        setUserEthRule(userRuleOf(BUY, 400e6), assetRule);

        buyEthAt(2070e18, 1);
        uint256 lastBuyAt = block.timestamp;

        // The second trigger's P0 is one minute after the buy, so the second P1 can be 61 s after the buy at the earliest.
        (uint256 triggerId,) = openEthAt(2000e18);
        uint256 sinceBuy;
        if (mode % 3 == 0) {
            sinceBuy = cooldown - 1;
        } else if (mode % 3 == 1) {
            sinceBuy = cooldown;
        } else {
            sinceBuy = bound(offset, 61, cooldown + 1 hours);
        }
        vm.warp(lastBuyAt + sinceBuy);
        IVault.SignedResponse memory p1 = signedEthPrice(2070e18, block.timestamp);

        if (sinceBuy < cooldown) {
            vm.expectRevert(abi.encodeWithSelector(IVault.CooldownActive.selector, lastBuyAt + cooldown));
            vm.prank(keeper);
            vault.confirmTrigger(triggerId, p1);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        } else {
            vm.prank(keeper);
            vault.confirmTrigger(triggerId, p1);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
        }
    }

    /// @notice setRule accepts the budget shares of its assets exactly when they add up to at most 100%
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_SetRuleAcceptsBudgetSharesOfAtMost100Percent(uint256 ethShare, uint256 oilShare) public {
        ethShare = bound(ethShare, 0, BPS);
        oilShare = bound(oilShare, 0, BPS);
        IVault.AssetRule memory eth = looseEthRule();
        eth.budgetShareBps = uint16(ethShare);
        IVault.AssetRule memory oil = oilRule();
        oil.budgetShareBps = uint16(oilShare);

        if (ethShare + oilShare > BPS) {
            vm.expectRevert(IVault.InvalidRule.selector);
            vm.prank(user);
            vault.setRule(rule(), two(ETH, OIL), twoRules(eth, oil), topics(2), watched());
        } else {
            vm.prank(user);
            vault.setRule(rule(), two(ETH, OIL), twoRules(eth, oil), topics(2), watched());
            (, IVault.AssetRule memory storedEth) = vault.getAssetRule(user, ETH);
            (, IVault.AssetRule memory storedOil) = vault.getAssetRule(user, OIL);
            assertEq(storedEth.budgetShareBps, ethShare, "ETH share");
            assertEq(storedOil.budgetShareBps, oilShare, "OIL share");
        }
    }
}
