// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../src/interfaces/IVault.sol";
import {AirnodeV2Attestation} from "../src/lib/AirnodeV2Attestation.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice Selling at a signed price: by hand, for take-profit, or as a stagnation exit. Entry is 2070.
contract SellingTest is VaultTestBase {
    uint256 positionId;
    uint256 boughtAt;

    function setUp() public override {
        super.setUp();
        positionId = buyEth();
        boughtAt = block.timestamp;
    }

    function test_ManualSell_ReturnsTheProceedsToTheBalance() public {
        vm.warp(boughtAt + 10 minutes);
        IVault.SignedResponse memory price = signedPrice("1900");

        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);

        // 50 / 2070 ETH at 1900, cut to whole micro-USDC
        assertEq(quoteOut, (uint256(50e18) / 2070) * 1900 / 1e12);
        assertEq(vault.balanceOf(user), 950e6 + quoteOut);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertEq(teth.balanceOf(address(vault)), 0);
    }

    function test_RevertWhen_SomeoneElseSellsByHand() public {
        vm.warp(boughtAt + 10 minutes);
        IVault.SignedResponse memory price = signedPrice("1900");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVault.NotPositionOwner.selector, keeper));
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_TakeProfit_AnyoneSellsAtEntryPlus8Percent() public {
        vm.warp(boughtAt + 1 hours);
        // 2070 * 1.08 = 2235.6
        vm.prank(keeper);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, signedPrice("2235.6"));
        assertGt(quoteOut, 50e6);
    }

    function test_RevertWhen_TakeProfitIsNotReached() public {
        vm.warp(boughtAt + 1 hours);
        IVault.SignedResponse memory price = signedPrice("2235.59");

        vm.expectRevert(abi.encodeWithSelector(IVault.TakeProfitNotReached.selector, 2235.59e18, 2235.6e18));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }

    function test_StagnationExit_AnyoneSellsAfterTheDelayWithinTheBand() public {
        vm.warp(boughtAt + 24 hours);
        // Within 2070 +- 1%
        vault.sell(positionId, IVault.SellReason.Stagnation, signedPrice("2080"));
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_RevertWhen_TheStagnationDelayIsNotOver() public {
        vm.warp(boughtAt + 24 hours - 1);
        IVault.SignedResponse memory price = signedPrice("2070");

        vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, boughtAt + 24 hours));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    function test_RevertWhen_ThePriceMovedOutOfTheStagnationBand() public {
        vm.warp(boughtAt + 24 hours);
        IVault.SignedResponse memory price = signedPrice("2091");

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideStagnationBand.selector, 2091e18, 2070e18));
        vault.sell(positionId, IVault.SellReason.Stagnation, price);
    }

    function test_RevertWhen_ThePositionSellsTwice() public {
        vm.warp(boughtAt + 10 minutes);
        IVault.SignedResponse memory price = signedPrice("1900");
        vm.startPrank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);

        vm.expectRevert(abi.encodeWithSelector(IVault.PositionNotOpen.selector, positionId));
        vault.sell(positionId, IVault.SellReason.Manual, price);
        vm.stopPrank();
    }

    function test_RevertWhen_ThePriceIsFromBeforeTheBuy() public {
        IVault.SignedResponse memory price = signedPriceAt("2300", boughtAt - 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceBeforeBuy.selector, boughtAt - 1, boughtAt));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }

    function test_RevertWhen_TheRuleIsPausedForAnAutomaticSell() public {
        vm.prank(user);
        vault.setPaused(true);
        vm.warp(boughtAt + 1 hours);
        IVault.SignedResponse memory price = signedPrice("2300");

        vm.expectRevert(abi.encodeWithSelector(IVault.RuleIsPaused.selector, user));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);

        // Selling by hand still works while paused.
        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    function test_RevertWhen_TheSellPriceIsForged() public {
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        vm.warp(boughtAt + 1 hours);
        IVault.SignedResponse memory price =
            sign(impostorKey, ETH_PRICE_REQUEST, block.timestamp, priceData("9999", block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        vault.sell(positionId, IVault.SellReason.TakeProfit, price);
    }
}
