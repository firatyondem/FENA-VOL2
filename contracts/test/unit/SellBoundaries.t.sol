// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Take-profit and stagnation exit at the exact edges, for a position bought at 2070 with the base rule:
/// take-profit +8% (target 2235.6), stagnation after Z = 24 h within Y = +-1% (2049.3 to 2090.7)
contract SellBoundariesTest is UnitBase {
    uint256 positionId;
    uint256 boughtAt;

    function setUp() public override {
        super.setUp();
        positionId = buyEth();
        boughtAt = block.timestamp;
        assertEq(vault.getPosition(positionId).entryPrice, 2070e18);
    }

    // Take-profit

    function test_Sell_TakesProfitAtExactlyTheTarget() public {
        vm.warp(boughtAt + 1 hours);
        IVault.SignedResponse memory price = signedPrice("2235.600000000000000000");

        vm.prank(keeper);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertEq(vault.balanceOf(user), 950e6 + quoteOut);
        assertGt(quoteOut, 50e6);
    }

    function test_RevertWhen_ThePriceIsOneWeiBelowTheTakeProfitTarget() public {
        vm.warp(boughtAt + 1 hours);
        IVault.SignedResponse memory price = signedPrice("2235.599999999999999999");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVault.TakeProfitNotReached.selector, 2235599999999999999999, 2235.6e18));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }

    function test_RevertWhen_TakeProfitIsOffAtAnyPrice() public {
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.takeProfitBps = 0;
        setUserEthRule(rule(), assetRule);
        vm.warp(boughtAt + 1 hours);
        IVault.SignedResponse memory price = signedPrice("1000000000000");

        vm.expectRevert(abi.encodeWithSelector(IVault.TakeProfitNotReached.selector, 1e30, type(uint256).max));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }

    // Stagnation: the delay Z

    function test_Sell_ExitsOnStagnationExactlyAtTheDelay() public {
        vm.warp(boughtAt + 24 hours);
        IVault.SignedResponse memory price = signedPrice("2070");

        vm.prank(keeper);
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheStagnationPriceIsOneSecondBeforeTheDelay() public {
        vm.warp(boughtAt + 24 hours - 1);
        IVault.SignedResponse memory price = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, boughtAt + 24 hours));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    /// @dev The delay is measured on the time the source took the price, not on the block time.
    function test_RevertWhen_TheStagnationPriceWasTakenOneSecondBeforeTheDelayButSubmittedLater() public {
        vm.warp(boughtAt + 24 hours + 1 minutes);
        IVault.SignedResponse memory price = signedPriceAt("2070", boughtAt + 24 hours - 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, boughtAt + 24 hours));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    // Stagnation: the band +-Y

    function test_Sell_ExitsOnStagnationAtExactlyTheUpperBandEdge() public {
        vm.warp(boughtAt + 24 hours);

        vault.sell(positionId, IVault.SellReason.Stagnation, signedPrice("2090.700000000000000000"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheStagnationPriceIsOneWeiAboveTheBand() public {
        vm.warp(boughtAt + 24 hours);
        IVault.SignedResponse memory price = signedPrice("2090.700000000000000001");

        vm.expectRevert(
            abi.encodeWithSelector(IVault.PriceOutsideStagnationBand.selector, 2090700000000000000001, 2070e18)
        );
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    function test_Sell_ExitsOnStagnationAtExactlyTheLowerBandEdge() public {
        vm.warp(boughtAt + 24 hours);

        vault.sell(positionId, IVault.SellReason.Stagnation, signedPrice("2049.300000000000000000"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheStagnationPriceIsOneWeiBelowTheBand() public {
        vm.warp(boughtAt + 24 hours);
        IVault.SignedResponse memory price = signedPrice("2049.299999999999999999");

        vm.expectRevert(
            abi.encodeWithSelector(IVault.PriceOutsideStagnationBand.selector, 2049299999999999999999, 2070e18)
        );
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    function test_RevertWhen_TheStagnationExitIsOff() public {
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.stagnationDelay = 0;
        setUserEthRule(rule(), assetRule);
        vm.warp(boughtAt + 365 days);
        IVault.SignedResponse memory price = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, type(uint256).max));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    // The sell price itself: taken no earlier than the buy

    function test_Sell_TakesProfitWithAPriceTakenAtTheSecondOfTheBuy() public {
        vm.warp(boughtAt + 1 minutes);
        IVault.SignedResponse memory price = signedPriceAt("2235.6", boughtAt);

        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheSellPriceWasTakenOneSecondBeforeTheBuy() public {
        vm.warp(boughtAt + 1 minutes);
        IVault.SignedResponse memory price = signedPriceAt("2235.6", boughtAt - 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceBeforeBuy.selector, boughtAt - 1, boughtAt));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertTrue(vault.getPosition(positionId).isOpen);
    }
}

/// @notice The sell edges for an entry price that is not a whole multiple of the percentages, so entry * (1 + bps) is
/// not a whole number of wei. Entry = 2070e18 + 1 wei: the take-profit target is 2235600000000000000001.08 wei and the
/// stagnation band is 2049300000000000000000.99 to 2090700000000000000001.01 wei.
contract SellRoundingBoundariesTest is UnitBase {
    uint256 positionId;
    uint256 boughtAt;

    function setUp() public override {
        super.setUp();
        positionId = buyEthAt("2000", "2070.000000000000000001");
        boughtAt = block.timestamp;
        assertEq(vault.getPosition(positionId).entryPrice, 2070000000000000000001);
    }

    function test_Sell_TakesProfitAtTheTargetRoundedUp() public {
        vm.warp(boughtAt + 1 hours);

        vault.sell(positionId, IVault.SellReason.TakeProfit, signedPrice("2235.600000000000000002"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    /// @dev IVault: "Anyone can sell a position when P >= entry * (1 + take-profit)". 2235600000000000000001 is below
    /// entry * 1.08 = 2235600000000000000001.08, so it must not sell. The trend and stagnation checks cross-multiply and
    /// are exact; this edge holds take-profit to the same standard. The reported target is not a whole number of wei,
    /// so the spec does not fix how the error rounds it, and only the selector is checked.
    function test_RevertWhen_ThePriceIsTheTakeProfitTargetRoundedDown() public {
        vm.warp(boughtAt + 1 hours);
        IVault.SignedResponse memory price = signedPrice("2235.600000000000000001");

        vm.expectPartialRevert(IVault.TakeProfitNotReached.selector);
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
        assertTrue(vault.getPosition(positionId).isOpen);
    }

    function test_Sell_ExitsOnStagnationAtTheUpperBandRoundedDown() public {
        vm.warp(boughtAt + 24 hours);

        vault.sell(positionId, IVault.SellReason.Stagnation, signedPrice("2090.700000000000000001"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheStagnationPriceIsTheUpperBandRoundedUp() public {
        vm.warp(boughtAt + 24 hours);
        IVault.SignedResponse memory price = signedPrice("2090.700000000000000002");

        vm.expectRevert(
            abi.encodeWithSelector(
                IVault.PriceOutsideStagnationBand.selector, 2090700000000000000002, 2070000000000000000001
            )
        );
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    function test_Sell_ExitsOnStagnationAtTheLowerBandRoundedUp() public {
        vm.warp(boughtAt + 24 hours);

        vault.sell(positionId, IVault.SellReason.Stagnation, signedPrice("2049.300000000000000001"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheStagnationPriceIsTheLowerBandRoundedDown() public {
        vm.warp(boughtAt + 24 hours);
        IVault.SignedResponse memory price = signedPrice("2049.300000000000000000");

        vm.expectRevert(
            abi.encodeWithSelector(
                IVault.PriceOutsideStagnationBand.selector, 2049300000000000000000, 2070000000000000000001
            )
        );
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }
}
