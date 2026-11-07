// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../src/interfaces/IVault.sol";
import {TestToken} from "./utils/TestToken.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice Selling at a Pyth price: by hand, for take-profit, stop-loss, or as a stagnation exit. Entry is 2070; the rule
/// takes profit at +8%, stops the loss at -5% and exits a position within 1% after 24 hours.
contract SellingTest is VaultTestBase {
    uint256 positionId;
    uint256 boughtAt;

    function setUp() public override {
        super.setUp();
        positionId = buyEth();
        boughtAt = block.timestamp;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Manual
    // ---------------------------------------------------------------------------------------------------------------

    function test_ManualSell_ReturnsTheProceedsToTheBalance() public {
        vm.warp(boughtAt + 10 minutes);
        bytes[] memory price = signedPrice("1900");

        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        // 50 / 2070 ETH at 1900, cut to whole micro-USDC
        assertEq(quoteOut, (uint256(50e18) / 2070) * 1900 / 1e12);
        assertEq(vault.balanceOf(user), 950e6 + quoteOut);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertEq(teth.balanceOf(address(vault)), 0);
    }

    function test_ManualSell_TakesAnyFreshPriceWithoutTheAgent() public {
        // The website fetches the latest Pyth update itself and the owner pays Pyth's fee; no agent is involved.
        pyth.setFee(10);
        vm.deal(user, 1 ether);
        vm.warp(boughtAt + 3 days);
        bytes[] memory latest = signedPriceAt("2500", block.timestamp - 4 minutes);

        vm.prank(user);
        vault.sell{value: 10}(positionId, IVault.SellReason.Manual, latest);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertEq(user.balance, 1 ether - 10);
    }

    function test_ManualSell_WorksAfterTheUserRemovedTheAgentAndTheAsset() public {
        vm.prank(user);
        vault.setRule(
            IVault.Rule({agent: makeAddr("new agent"), buyAmount: 1, maxPerTrade: 1, dailyLimit: 0}),
            new bytes32[](0),
            new IVault.AssetRule[](0),
            new string[](0),
            new bytes32[](0)
        );
        vm.warp(boughtAt + 10 minutes);

        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, signedPrice("1900"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_SomeoneElseSellsByHand() public {
        vm.warp(boughtAt + 10 minutes);
        bytes[] memory price = signedPrice("1900");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVault.NotPositionOwner.selector, keeper));
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_RevertWhen_TheAgentSellsByHand() public {
        vm.warp(boughtAt + 10 minutes);
        bytes[] memory price = signedPrice("1900");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.NotPositionOwner.selector, agent));
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_RevertWhen_TheManualSellPriceIsStale() public {
        // A closed market publishes no new prices, so a manual sell waits for the open.
        vm.warp(boughtAt + 1 days);
        uint256 lastClose = block.timestamp - 5 minutes - 1;
        bytes[] memory price = signedPriceAt("1900", lastClose);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, lastClose));
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_RevertWhen_TheManualSellPriceIsForAnotherAsset() public {
        vm.warp(boughtAt + 10 minutes);
        bytes[] memory btc = signedPriceOf(BTC_FEED, "80000", block.timestamp);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IVault.WrongPriceFeed.selector, ETH_FEED));
        vault.sell(positionId, IVault.SellReason.Manual, btc);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Take-profit
    // ---------------------------------------------------------------------------------------------------------------

    function test_TakeProfit_AnyoneSellsAtEntryPlus8Percent() public {
        vm.warp(boughtAt + 1 hours);
        // 2070 * 1.08 = 2235.6
        vm.prank(keeper);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, signedPrice("2235.6"));
        assertGt(quoteOut, 50e6);
    }

    function test_RevertWhen_TakeProfitIsNotReached() public {
        vm.warp(boughtAt + 1 hours);
        bytes[] memory price = signedPrice("2235.59999999");

        vm.expectRevert(abi.encodeWithSelector(IVault.TakeProfitNotReached.selector, 2235.59999999e18, 2235.6e18));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Stop-loss: 2070 * 0.95 = 1966.5
    // ---------------------------------------------------------------------------------------------------------------

    function test_StopLoss_AnyoneSellsExactlyAtTheLine() public {
        vm.warp(boughtAt + 1 hours);
        vm.expectEmit(address(vault));
        emit IVault.PositionSold(
            positionId, user, IVault.SellReason.StopLoss, 1966.5e18, (uint256(50e18) / 2070) * 19665 / 1e13
        );
        vm.prank(makeAddr("anyone"));
        vault.sell(positionId, IVault.SellReason.StopLoss, signedPrice("1966.5"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_StopLoss_SellsBelowTheLine() public {
        vm.warp(boughtAt + 1 hours);
        vm.prank(keeper);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.StopLoss, signedPrice("1500"));
        assertLt(quoteOut, 50e6);
        assertEq(vault.balanceOf(user), 950e6 + quoteOut);
    }

    function test_RevertWhen_ThePriceIsAboveTheStopLossLine() public {
        vm.warp(boughtAt + 1 hours);
        // One unit of Pyth's grain (1e-8 USD) above the line
        bytes[] memory price = signedPrice("1966.50000001");

        vm.expectRevert(abi.encodeWithSelector(IVault.StopLossNotReached.selector, 1966.50000001e18, 1966.5e18));
        vault.sell(positionId, IVault.SellReason.StopLoss, price);
    }

    function test_RevertWhen_StopLossIsOff() public {
        // A position bought under a rule with stop-loss off never sells for stop-loss, however far it falls.
        IVault.AssetRule memory noStop = ethRule();
        noStop.stopLossBps = 0;
        noStop.cooldown = 0;
        vm.prank(user);
        setEthRule(noStop);
        uint256 second = buyEth();
        vm.warp(block.timestamp + 1 hours);
        bytes[] memory crash = signedPrice("1");

        vm.expectRevert(abi.encodeWithSelector(IVault.StopLossNotReached.selector, 1e18, 0));
        vault.sell(second, IVault.SellReason.StopLoss, crash);
    }

    function test_RevertWhen_TheRuleIsPausedForAStopLoss() public {
        vm.prank(user);
        vault.setPaused(true);
        vm.warp(boughtAt + 1 hours);
        bytes[] memory price = signedPrice("1500");

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        vault.sell(positionId, IVault.SellReason.StopLoss, price);

        // Selling by hand still works while paused.
        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_StopLoss_UsesThePositionsOwnLineAfterTheRuleChanges() public {
        // The user turns stop-loss off after the buy. The open position keeps the line it was bought with.
        IVault.AssetRule memory noStop = ethRule();
        noStop.stopLossBps = 0;
        noStop.takeProfitBps = 0;
        vm.prank(user);
        setEthRule(noStop);

        IVault.PositionExits memory exits = vault.getPositionExits(positionId);
        assertEq(exits.stopLossBps, 500);
        assertEq(exits.takeProfitBps, 800);

        vm.warp(boughtAt + 1 hours);
        vault.sell(positionId, IVault.SellReason.StopLoss, signedPrice("1966.5"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_TakeProfit_StillSellsAfterTheUserTookTheAssetOutOfTheRule() public {
        vm.prank(user);
        vault.setRule(rule(), new bytes32[](0), new IVault.AssetRule[](0), new string[](0), watched());
        vm.warp(boughtAt + 1 hours);

        vault.sell(positionId, IVault.SellReason.TakeProfit, signedPrice("2235.6"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Stagnation
    // ---------------------------------------------------------------------------------------------------------------

    function test_StagnationExit_AnyoneSellsAfterTheDelayWithinTheBand() public {
        vm.warp(boughtAt + 24 hours);
        // Within 2070 +- 1%
        vault.sell(positionId, IVault.SellReason.Stagnation, signedPrice("2080"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheStagnationDelayIsNotOver() public {
        vm.warp(boughtAt + 24 hours - 1);
        bytes[] memory price = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, boughtAt + 24 hours));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    function test_RevertWhen_ThePriceMovedOutOfTheStagnationBand() public {
        vm.warp(boughtAt + 24 hours);
        bytes[] memory price = signedPrice("2091");

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideStagnationBand.selector, 2091e18, 2070e18));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Every sell
    // ---------------------------------------------------------------------------------------------------------------

    function test_RevertWhen_ThePositionSellsTwice() public {
        vm.warp(boughtAt + 10 minutes);
        bytes[] memory price = signedPrice("1900");
        vm.startPrank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);

        vm.expectRevert(abi.encodeWithSelector(IVault.PositionNotOpen.selector, positionId));
        vault.sell(positionId, IVault.SellReason.Manual, price);
        vm.stopPrank();
    }

    function test_RevertWhen_ThePriceIsFromBeforeTheBuy() public {
        bytes[] memory price = signedPriceAt("2300", boughtAt - 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceBeforeBuy.selector, boughtAt - 1, boughtAt));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }

    function test_RevertWhen_TheRuleIsPausedForAnAutomaticSell() public {
        vm.prank(user);
        vault.setPaused(true);
        vm.warp(boughtAt + 1 hours);
        bytes[] memory price = signedPrice("2300");

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);

        // Selling by hand still works while paused.
        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_Sell_SellsTheBoughtTokenAfterTheProfileChangesItsToken() public {
        IVault.AssetProfile memory profile = ethProfile();
        profile.token = address(new TestToken("Other ETH", "oETH", 18));
        vault.setAssetProfile(ETH, profile);
        vm.warp(boughtAt + 10 minutes);
        bytes[] memory price = signedPrice("1900");

        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);
        assertEq(teth.balanceOf(address(vault)), 0);
    }

    function test_RevertWhen_TheSellPriceIsForged() public {
        vm.warp(boughtAt + 1 hours);
        bytes[] memory price = edited(signedPrice("9999"));

        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }
}
