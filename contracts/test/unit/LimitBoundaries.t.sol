// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Max per trade at the exact edge: a buy amount equal to the limit buys, one unit above is refused
/// @dev PerTradeLimitExceeded cannot be reached through confirmTrigger. setRule rejects buyAmount > maxPerTrade with
/// InvalidRule, both fields live in the same stored Rule and only setRule writes them, always together. So by the time
/// _spend compares them, buyAmount <= maxPerTrade always holds, and the edge "one unit above" shows up at setRule.
contract PerTradeBoundariesTest is UnitBase {
    function test_ConfirmTrigger_BuysExactlyMaxPerTrade() public {
        setUserEthRule(IVault.Rule({agent: agent, buyAmount: 80e6, maxPerTrade: 80e6, dailyLimit: 200e6}), ethRule());

        uint256 positionId = buyEth();
        assertEq(vault.getPosition(positionId).cost, 80e6);
        assertEq(vault.balanceOf(user), 920e6);
        assertEq(vault.spentToday(user, ETH), 80e6);
    }

    function test_RevertWhen_TheBuyAmountIsOneUnitAboveMaxPerTrade() public {
        IVault.Rule memory tooBig =
            IVault.Rule({agent: agent, buyAmount: 80e6 + 1, maxPerTrade: 80e6, dailyLimit: 200e6});

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setRule(tooBig, one(ETH), oneRule(ethRule()), topics(1), watched());
    }

    function test_ARefusedRuleKeepsThePreviousRule() public {
        IVault.Rule memory tooBig =
            IVault.Rule({agent: agent, buyAmount: 80e6 + 1, maxPerTrade: 80e6, dailyLimit: 200e6});
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setRule(tooBig, one(ETH), oneRule(ethRule()), topics(1), watched());

        (IVault.Rule memory stored,,) = vault.getRule(user);
        assertEq(stored.buyAmount, 50e6);
        assertEq(stored.maxPerTrade, 50e6);
    }
}

/// @notice Daily limit and budget share at the exact edge: spending exactly the asset's budget buys, one unit more
/// reverts with DailyBudgetExceeded
/// @dev Cooldown is off here, so only the budget limits the buys.
contract DailyBudgetBoundariesTest is UnitBase {
    function setUp() public override {
        super.setUp();
        // Enough for every buy below, so the balance never limits a buy
        fund(user, 9_000e6);
    }

    function test_ConfirmTrigger_SpendsExactlyTheDailyLimitInOneBuy() public {
        setLimits(50e6, 10_000);

        buyEth();
        assertEq(vault.spentToday(user, ETH), 50e6);
    }

    function test_RevertWhen_TheDailyLimitIsOneUnitBelowTheBuy() public {
        setLimits(50e6 - 1, 10_000);

        expectBuyToRevertWith(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 50e6 - 1));
    }

    function test_ConfirmTrigger_SpendsExactlyTheDailyLimitInTwoBuys() public {
        setLimits(100e6, 10_000);

        buyEth();
        buyEth();
        assertEq(vault.spentToday(user, ETH), 100e6);
    }

    function test_RevertWhen_TheSecondBuyIsOneUnitAboveTheDailyLimit() public {
        setLimits(100e6 - 1, 10_000);
        buyEth();

        expectBuyToRevertWith(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 50e6 - 1));
        assertEq(vault.spentToday(user, ETH), 50e6);
    }

    function test_ConfirmTrigger_SpendsExactlyTheBudgetShare() public {
        // 25% of 200 USDC = 50 USDC
        setLimits(200e6, 2_500);

        buyEth();
        assertEq(vault.spentToday(user, ETH), 50e6);
    }

    function test_RevertWhen_TheBudgetShareIsOneBasisPointTooSmall() public {
        // 24.99% of 200 USDC = 49.98 USDC
        setLimits(200e6, 2_499);

        expectBuyToRevertWith(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 49_980_000));
    }

    function test_RevertWhen_TheBudgetShareIsOneUnitBelowTheBuy() public {
        // 25% of 199.999999 USDC = 49.99999975 USDC, rounded down to 49.999999
        setLimits(200e6 - 1, 2_500);

        expectBuyToRevertWith(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 50e6 - 1));
    }

    function test_SetRule_AcceptsBudgetSharesThatAddUpToExactly100Percent() public {
        IVault.AssetRule memory ethShare = ethRule();
        ethShare.budgetShareBps = 5_000;
        IVault.AssetRule memory oilShare = oilRule();
        oilShare.budgetShareBps = 5_000;

        vm.prank(user);
        vault.setRule(rule(), two(ETH, OIL), twoRules(ethShare, oilShare), topics(2), watched());
        (bool isAllowed,) = vault.getAssetRule(user, OIL);
        assertTrue(isAllowed);
    }

    function test_RevertWhen_BudgetSharesAddUpToOneBasisPointAbove100Percent() public {
        IVault.AssetRule memory ethShare = ethRule();
        ethShare.budgetShareBps = 5_000;
        IVault.AssetRule memory oilShare = oilRule();
        oilShare.budgetShareBps = 5_001;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.InvalidRule.selector));
        vault.setRule(rule(), two(ETH, OIL), twoRules(ethShare, oilShare), topics(2), watched());
    }

    /// @dev ETH and OIL each get 50% of a 100 USDC daily limit. One buy of each spends exactly the daily limit in total,
    /// and a third buy on the same day is refused with nothing left.
    function test_ConfirmTrigger_SpendsExactlyTheDailyLimitAcrossTwoAssets() public {
        IVault.AssetRule memory ethShare = ethRule();
        ethShare.cooldown = 0;
        ethShare.budgetShareBps = 5_000;
        IVault.AssetRule memory oilShare = oilRule();
        oilShare.cooldown = 0;
        oilShare.budgetShareBps = 5_000;
        vm.prank(user);
        vault.setRule(
            IVault.Rule({agent: agent, buyAmount: 50e6, maxPerTrade: 50e6, dailyLimit: 100e6}),
            two(ETH, OIL),
            twoRules(ethShare, oilShare),
            topics(2),
            watched()
        );
        uint256 day = block.timestamp / 1 days;

        buyEth();
        uint256 oilTriggerId = openTriggerFor(user, agent, OIL, OIL_PRICE_REQUEST, "80");
        vm.warp(block.timestamp + 61 minutes);
        IVault.SignedResponse memory oilP1 = signedPriceOf(OIL_PRICE_REQUEST, "81.5", block.timestamp);
        vault.confirmTrigger(oilTriggerId, oilP1);
        assertEq(vault.spentToday(user, ETH) + vault.spentToday(user, OIL), 100e6);
        assertEq(vault.balanceOf(user), 10_000e6 - 100e6);

        expectBuyToRevertWith(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 0));
        assertEq(block.timestamp / 1 days, day);
    }

    /// @dev IVault: dailyLimit is the most quote tokens spent per UTC day, with no upper bound, and setRule accepts any
    /// value. 2^256 - 1 is what a client sends for "no limit"; a 50 USDC buy is far inside it, so it buys.
    function test_ConfirmTrigger_BuysUnderTheLargestDailyLimit() public {
        setLimits(type(uint256).max, 10_000);

        buyEth();
        assertEq(vault.spentToday(user, ETH), 50e6);
    }

    /// @dev The budget is a UTC-day bucket (block.timestamp / 1 days), as IVault says, not a rolling 24 h.
    function test_DailyBudget_ResetsAtTheNextUtcMidnight() public {
        setLimits(50e6, 10_000);
        buyEth();
        uint256 firstBuyAt = block.timestamp;
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;

        // A trigger whose window spans midnight
        vm.warp(midnight - 32 minutes);
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        assertEq(t0, midnight - 31 minutes);

        // Last second of the day: the budget is spent.
        vm.warp(midnight - 1);
        IVault.SignedResponse memory lastSecond = signedPrice("2070");
        vm.expectRevert(abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, 50e6, 0));
        vault.confirmTrigger(triggerId, lastSecond);

        // First second of the next day: a fresh budget, less than 24 h after the first buy.
        confirmAt(triggerId, midnight, "2070");
        assertEq(vault.spentToday(user, ETH), 50e6);
        assertLt(block.timestamp - firstBuyAt, 24 hours);
    }

    function test_DailyBudget_IsFreeAgain24HoursAfterASpentDay() public {
        setLimits(50e6, 10_000);
        buyEth();
        uint256 firstBuyAt = block.timestamp;

        vm.warp(firstBuyAt + 24 hours - 31 minutes);
        (uint256 triggerId,) = openEthTriggerNow("2000");
        confirmAt(triggerId, firstBuyAt + 24 hours, "2070");
        assertEq(vault.spentToday(user, ETH), 50e6);
    }

    /// @dev Sets a rule with 50 USDC per buy, max 50 per trade, no cooldown, and the given daily limit and share
    function setLimits(uint256 dailyLimit, uint16 budgetShareBps) private {
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.cooldown = 0;
        assetRule.budgetShareBps = budgetShareBps;
        setUserEthRule(
            IVault.Rule({agent: agent, buyAmount: 50e6, maxPerTrade: 50e6, dailyLimit: dailyLimit}), assetRule
        );
    }

    /// @dev Opens a trigger at 2000 and expects a P1 of 2070 after 31 min to revert with `revertData`
    function expectBuyToRevertWith(bytes memory revertData) private {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        vm.warp(t0 + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2070");
        uint256 balanceBefore = vault.balanceOf(user);

        vm.expectRevert(revertData);
        vault.confirmTrigger(triggerId, p1);
        assertEq(vault.balanceOf(user), balanceBefore);
        assertStatus(triggerId, IVault.TriggerStatus.Open);
    }
}

/// @notice Cooldown at the exact edge: a buy exactly `cooldown` after the last one goes through, 1 s earlier does not.
/// The base rule's cooldown is 24 h.
contract CooldownBoundariesTest is UnitBase {
    uint256 boughtAt;
    uint256 secondTriggerId;

    function setUp() public override {
        super.setUp();
        buyEth();
        boughtAt = block.timestamp;
        // A second trigger whose window covers the end of the cooldown
        vm.warp(boughtAt + 24 hours - 32 minutes);
        (secondTriggerId,) = openEthTriggerNow("2000");
    }

    function test_ConfirmTrigger_BuysExactlyWhenTheCooldownEnds() public {
        confirmAt(secondTriggerId, boughtAt + 24 hours, "2070");
        assertStatus(secondTriggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_TheCooldownHasOneSecondLeft() public {
        vm.warp(boughtAt + 24 hours - 1);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.CooldownActive.selector, boughtAt + 24 hours));
        vault.confirmTrigger(secondTriggerId, p1);
    }
}

/// @notice The cooldown edge for a cooldown shorter than a day, so both buys fall on the same UTC day
contract ShortCooldownBoundariesTest is UnitBase {
    uint256 lastBuyAt;
    uint256 nextTriggerId;

    function setUp() public override {
        super.setUp();
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.cooldown = 32 minutes;
        setUserEthRule(rule(), assetRule);
        buyEth();
        lastBuyAt = block.timestamp;
        // t0 = lastBuyAt + 1 min, so P1 passes the 30 min wait from lastBuyAt + 31 min on
        (nextTriggerId,) = openEthTriggerNow("2000");
    }

    function test_ConfirmTrigger_BuysExactlyWhenTheCooldownEnds() public {
        confirmAt(nextTriggerId, lastBuyAt + 32 minutes, "2070");
        assertStatus(nextTriggerId, IVault.TriggerStatus.Confirmed);
        assertEq(vault.spentToday(user, ETH), 100e6);
    }

    function test_RevertWhen_TheCooldownHasOneSecondLeft() public {
        vm.warp(lastBuyAt + 32 minutes - 1);
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.CooldownActive.selector, lastBuyAt + 32 minutes));
        vault.confirmTrigger(nextTriggerId, p1);
    }
}
