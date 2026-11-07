// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice A price of 0 or below: Pyth can publish one, and the vault refuses it before any other check, so nothing
/// moves
contract ZeroPriceTest is UnitBase {
    function test_RevertWhen_P1IsZero() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("0");

        vm.expectRevert(IVault.PriceNotPositive.selector);
        vault.confirmTrigger(triggerId, p1);
        assertStatus(triggerId, IVault.TriggerStatus.Open);
    }

    function test_RevertWhen_P1IsNegative() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("2000");
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = pythUpdate(ETH_FEED, -1, 0, -8, block.timestamp, NO_PREV);

        vm.expectRevert(IVault.PriceNotPositive.selector);
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_P0IsZero() public {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory p0 = signedPrice("0");

        vm.prank(agent);
        vm.expectRevert(IVault.PriceNotPositive.selector);
        openTriggerWith(user, ETH, tweet, p0);
        assertEq(vault.triggerCount(), 0);
    }

    function test_RevertWhen_AManualSellIsAtAZeroPrice() public {
        uint256 positionId = buyEth();
        uint256 amount = vault.getPosition(positionId).amount;
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("0");

        vm.prank(user);
        vm.expectRevert(IVault.PriceNotPositive.selector);
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertTrue(vault.getPosition(positionId).isOpen);
        assertEq(teth.balanceOf(address(vault)), amount);
        assertEq(vault.balanceOf(user), 950e6);
    }

    function test_RevertWhen_AStopLossSellIsAtAZeroPrice() public {
        // A zero price would pass any stop-loss line, so it must never reach the check.
        uint256 positionId = buyEth();
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("0");

        vm.expectRevert(IVault.PriceNotPositive.selector);
        vault.sell(positionId, IVault.SellReason.StopLoss, price);
    }

    function test_RevertWhen_MockDEXBuysAtAZeroPrice() public {
        usdc.mint(address(this), 50e6);
        usdc.approve(address(dex), 50e6);

        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroPrice.selector));
        dex.buy(address(teth), 50e6, 0);
    }
}

/// @notice A price of 1 wei (1e-18 USD): no overflow, and every invalid use reverts with a clean custom error
contract OneWeiPriceTest is UnitBase {
    /// @dev P0 = 1 wei needs 1.03 wei <= P1 <= 1.12 wei, and no whole number of wei lies in that range.
    function test_RevertWhen_P0AndP1AreOneWei() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("0.000000000000000001");
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("0.000000000000000001");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 1, 1));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_P0IsOneWeiAndP1IsTwoWei() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("0.000000000000000001");
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("0.000000000000000002");

        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 1, 2));
        vault.confirmTrigger(triggerId, p1);
    }

    /// @dev 10 wei is the lowest P1 that a 3% threshold and a 12% cap can buy (P0 = 9 wei). 50 USDC buys 5e36 tETH wei
    /// there, and the same price sells them back for exactly 50 USDC.
    function test_ConfirmTrigger_BuysAtTenWeiWithoutOverflow() public {
        uint256 positionId = buyEthAt("0.000000000000000009", "0.000000000000000010");
        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.entryPrice, 10);
        assertEq(position.amount, 5e36);

        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("0.000000000000000010");
        vm.prank(user);
        assertEq(vault.sell(positionId, IVault.SellReason.Manual, price), 50e6);
        assertEq(vault.balanceOf(user), 1_000e6);
    }

    function test_RevertWhen_P0IsNineWeiAndP1IsOneWeiBelowTen() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("0.000000000000000009");
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("0.000000000000000009");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 9, 9));
        vault.confirmTrigger(triggerId, p1);
    }

    /// @dev 0.024154589371980676 tETH at 1 wei is worth 2.4e-14 units of mock USDC, rounded down to 0.
    function test_RevertWhen_AManualSellIsAtOneWei() public {
        uint256 positionId = buyEth();
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("0.000000000000000001");

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroOutput.selector));
        vault.sell(positionId, IVault.SellReason.Manual, price);
        assertTrue(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_AStagnationSellIsAtOneWei() public {
        uint256 positionId = buyEth();
        vm.warp(block.timestamp + 24 hours);
        bytes[] memory price = signedPrice("0.000000000000000001");

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideStagnationBand.selector, 1, 2070e18));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    /// @dev 1,000 USDC at 1 wei buys 1e39 tETH wei, and they sell back for exactly 1,000 USDC.
    function test_MockDEX_SwapsAtOneWeiWithoutOverflow() public {
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(dex), 1_000e6);
        uint256 assetOut = dex.buy(address(teth), 1_000e6, 1);
        assertEq(assetOut, 1e39);

        teth.approve(address(dex), assetOut);
        assertEq(dex.sell(address(teth), assetOut, 1), 1_000e6);
        assertEq(usdc.balanceOf(address(this)), 1_000e6);
    }
}

/// @notice A price of 1e30 wei (1e12 USD per token): the Gate 2, take-profit and swap arithmetic do not overflow. "One
/// wei" is Pyth's finest step at that size, 1e12 wei (exponent -6).
contract HugePriceTest is UnitBase {
    // 1e30 wei and 0.9e30 wei as 18-decimal strings
    string constant P_1E30 = "1000000000000.000000000000000000";
    string constant P_090 = "900000000000.000000000000000000";

    function test_ConfirmTrigger_BuysAtExactlyTheThresholdOf1e30() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(P_1E30);
        uint256 positionId = confirmAt(triggerId, t0 + 31 minutes, "1030000000000.000000000000000000");
        assertEq(vault.getPosition(positionId).entryPrice, 1.03e30);
    }

    function test_RevertWhen_P1IsOneWeiBelowTheThresholdOf1e30() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(P_1E30);
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("1029999999999.999999");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 1e30, 1.03e30 - 1e12));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_ConfirmTrigger_BuysAtExactlyTheSpikeCapOf1e30() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(P_1E30);
        uint256 positionId = confirmAt(triggerId, t0 + 31 minutes, "1120000000000.000000000000000000");
        assertEq(vault.getPosition(positionId).entryPrice, 1.12e30);
    }

    function test_RevertWhen_P1IsOneWeiAboveTheSpikeCapOf1e30() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(P_1E30);
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("1120000000000.000001");

        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 1e30, 1.12e30 + 1e12));
        vault.confirmTrigger(triggerId, p1);
    }

    /// @dev At 1e30 one asset wei costs exactly one unit of mock USDC: 50 USDC buy 50e6 wei, and take-profit at
    /// 1.08e30 pays exactly 54 USDC.
    function test_ConfirmTrigger_BuysAndTakesProfitAt1e30() public {
        uint256 positionId = buyEthAt(P_090, P_1E30);
        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.entryPrice, 1e30);
        assertEq(position.amount, 50e6);

        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("1080000000000.000000000000000000");
        vm.prank(keeper);
        assertEq(vault.sell(positionId, IVault.SellReason.TakeProfit, price), 54e6);
        assertEq(vault.balanceOf(user), 1_004e6);
    }

    function test_RevertWhen_TheTakeProfitPriceIsOneWeiBelowTheTargetOf1e30() public {
        uint256 positionId = buyEthAt(P_090, P_1E30);
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("1079999999999.999999");

        vm.expectRevert(abi.encodeWithSelector(IVault.TakeProfitNotReached.selector, 1.08e30 - 1e12, 1.08e30));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }

    /// @dev A 2070 position sold at 1e30 pays 24,154,589,371.980676 mock USDC without overflow.
    function test_Sell_TakesProfitAt1e30ForAnOrdinaryPosition() public {
        uint256 positionId = buyEth();
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice(P_1E30);

        vm.prank(keeper);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertEq(quoteOut, 24154589371980676);
        assertEq(vault.balanceOf(user), 950e6 + 24154589371980676);
        assertEq(usdc.balanceOf(address(vault)), vault.balanceOf(user));
    }

    /// @dev The smallest buy at 1e30: 1 unit of mock USDC buys exactly 1 asset wei and sells back for 1 unit.
    function test_ConfirmTrigger_BuysOneAssetWeiForOneUnitAt1e30() public {
        setUserEthRule(IVault.Rule({agent: agent, buyAmount: 1, maxPerTrade: 1, dailyLimit: 1}), ethRule());
        uint256 positionId = buyEthAt(P_090, P_1E30);
        assertEq(vault.getPosition(positionId).amount, 1);

        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice(P_1E30);
        vm.prank(user);
        assertEq(vault.sell(positionId, IVault.SellReason.Manual, price), 1);
        assertEq(vault.balanceOf(user), 1_000e6);
    }

    /// @dev Above 1e30, 1 unit buys less than 1 asset wei. MockDEX refuses a swap that delivers nothing, so the buy
    /// reverts and the trigger stays open with the balance untouched.
    function test_RevertWhen_OneUnitBuysLessThanOneAssetWeiAboveTheEdge() public {
        setUserEthRule(IVault.Rule({agent: agent, buyAmount: 1, maxPerTrade: 1, dailyLimit: 1}), ethRule());
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(P_090);
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("1000000000000.000001");

        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroOutput.selector));
        vault.confirmTrigger(triggerId, p1);
        assertStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(user), 1_000e6);
        assertEq(vault.spentToday(user, ETH), 0);
    }
}

/// @notice The same extremes as whole-dollar prices: "1" is 1 USD (1e18 wei) and 1e30 USD is 1e48 wei, which Pyth writes
/// with a positive exponent. "One wei" is Pyth's finest step at each size. The
/// Gate 2 and swap arithmetic do not overflow there either, and a buy that cannot pay for even 1 asset wei reverts with
/// a custom error.
contract WholeDollarPriceExtremesTest is UnitBase {
    // 1e30 USD = 1e48 wei, and Pyth's finest step there: an exponent of +12
    uint256 constant HUGE = 1e48;
    uint256 constant HUGE_UNIT = 1e30;

    function test_ConfirmTrigger_BuysAtExactlyTheThresholdOfOneDollar() public {
        uint256 positionId = buyEthAt("1", "1.03");
        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.entryPrice, 1.03e18);
        // 50 USDC / 1.03 USD, rounded down to the wei
        assertEq(position.amount, 48543689320388349514);
    }

    function test_RevertWhen_P1IsOneWeiBelowTheThresholdOfOneDollar() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow("1");
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice("1.029999999999999999");

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, 1e18, 1.03e18 - 1));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_BuyThenSellAtOneDollar_ReturnsExactlyTheCost() public {
        uint256 positionId = buyEthAt("0.95", "1");
        assertEq(vault.getPosition(positionId).amount, 50e18);

        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("1");
        vm.prank(user);
        assertEq(vault.sell(positionId, IVault.SellReason.Manual, price), 50e6);
        assertEq(vault.balanceOf(user), 1_000e6);
    }

    function test_RevertWhen_P1IsOneWeiBelowTheThresholdOf1e30Dollars() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(decimalString(HUGE));
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice(decimalString(HUGE * 103 / 100 - HUGE_UNIT));

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, HUGE, HUGE * 103 / 100 - HUGE_UNIT));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_P1IsOneWeiAboveTheSpikeCapOf1e30Dollars() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(decimalString(HUGE));
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice(decimalString(HUGE * 112 / 100 + HUGE_UNIT));

        vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, HUGE, HUGE * 112 / 100 + HUGE_UNIT));
        vault.confirmTrigger(triggerId, p1);
    }

    /// @dev P1 = 1.03e30 USD passes the trend, but 50 USDC buy less than 1 asset wei there. MockDEX refuses a swap that
    /// delivers nothing, so the buy reverts and nothing is spent.
    function test_RevertWhen_FiftyUsdcBuyLessThanOneAssetWeiAt1e30Dollars() public {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(decimalString(HUGE));
        vm.warp(t0 + 31 minutes);
        bytes[] memory p1 = signedPrice(decimalString(HUGE * 103 / 100));

        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroOutput.selector));
        vault.confirmTrigger(triggerId, p1);
        assertStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(user), 1_000e6);
        assertEq(vault.spentToday(user, ETH), 0);
    }

    /// @dev A 2070 position sold at 1e30 USD pays 24154589371980676e18 units of mock USDC without overflow.
    function test_Sell_TakesProfitAt1e30DollarsWithoutOverflow() public {
        uint256 positionId = buyEth();
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice(decimalString(HUGE));

        vm.prank(keeper);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertEq(quoteOut, 24154589371980676e18);
        assertEq(vault.balanceOf(user), 950e6 + 24154589371980676e18);
        assertEq(usdc.balanceOf(address(vault)), vault.balanceOf(user));
    }

    function test_RevertWhen_AStagnationSellIsAt1e30Dollars() public {
        uint256 positionId = buyEth();
        vm.warp(block.timestamp + 24 hours);
        bytes[] memory price = signedPrice(decimalString(HUGE));

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideStagnationBand.selector, HUGE, 2070e18));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }
}
