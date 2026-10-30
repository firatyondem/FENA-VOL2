// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {FuzzBase} from "./FuzzBase.sol";

/// @notice Selling decides as the spec says for any entry price, take-profit, stagnation band and delay: take-profit
/// sells at P >= entry * (1 + take-profit), a stagnation exit sells once the delay is over and P is within entry * (1
/// +- band), and a buy followed by a sell at the same price never creates value
contract SellFuzzTest is FuzzBase {
    uint256 constant BUY = 50e6;
    uint256 constant DEPOSIT = 1_000e6;

    function setUp() public override {
        super.setUp();
        useWideEthProfile();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Take-profit
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Whether a take-profit sell goes through equals P * 10_000 >= entry * (10_000 + take-profit), and
    /// take-profit 0 never sells
    /// @dev Includes floor(target) when the target is not a whole number of wei: that price is short of the target by
    /// less than a wei, so it must not sell.
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_TakeProfitDecisionEqualsTheFormula(
        uint256 entry,
        uint256 takeProfitBps,
        uint256 priceSeed,
        uint8 mode
    ) public {
        entry = bound(entry, 1000, MAX_PRICE);
        takeProfitBps = bound(takeProfitBps, 0, type(uint16).max);
        uint256 price = pickTakeProfitPrice(entry, takeProfitBps, priceSeed, mode);
        uint256 product = entry * (BPS + takeProfitBps);

        IVault.AssetRule memory assetRule = looseEthRule();
        assetRule.takeProfitBps = uint16(takeProfitBps);
        setUserEthRule(userRuleOf(BUY, BUY), assetRule);
        uint256 positionId = buyEthAt(entry, 1);

        vm.warp(block.timestamp + 1 hours);
        bool shouldSell = takeProfitBps != 0 && price * BPS >= product;
        sellForTakeProfit(positionId, price, shouldSell);
    }

    /// @dev A price at an edge of the take-profit target or anywhere around it: the target rounded up, above it, the
    /// target rounded down (below the exact target unless that is a whole wei), one wei below that, or any price
    function pickTakeProfitPrice(uint256 entry, uint256 takeProfitBps, uint256 priceSeed, uint8 mode)
        internal
        pure
        returns (uint256)
    {
        uint256 product = entry * (BPS + takeProfitBps);
        uint256 ceilTarget = Math.ceilDiv(product, BPS);
        if (mode % 5 == 0) return ceilTarget;
        if (mode % 5 == 1) return ceilTarget + priceSeed % entry;
        if (mode % 5 == 2) return product / BPS;
        if (mode % 5 == 3) return product / BPS - 1;
        return bound(priceSeed, 1, 2 * ceilTarget);
    }

    function sellForTakeProfit(uint256 positionId, uint256 price, bool shouldSell) internal {
        IVault.SignedResponse memory response = signedEthPrice(price, block.timestamp);
        if (!shouldSell) {
            vm.expectPartialRevert(IVault.TakeProfitNotReached.selector);
            vm.prank(keeper);
            vault.sell(positionId, IVault.SellReason.TakeProfit, response);
            assertTrue(vault.getPosition(positionId).isOpen, "still open");
            return;
        }
        uint256 amount = vault.getPosition(positionId).amount;
        vm.prank(keeper);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.TakeProfit, response);
        assertFalse(vault.getPosition(positionId).isOpen, "closed");
        assertEq(quoteOut, expectedQuoteOut(amount, price, 18), "quote out");
        assertEq(vault.balanceOf(user), DEPOSIT - BUY + quoteOut, "balance");
        assertEq(teth.balanceOf(address(vault)), 0, "no asset left");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Stagnation exit
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Whether a stagnation exit goes through equals priceTime >= openedAt + delay and
    /// |P - entry| * 10_000 <= entry * band; the delay is judged first
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_StagnationDecisionEqualsTheFormula(
        uint256 entry,
        uint256 bandBps,
        uint256 delay,
        uint256 elapsed,
        uint256 priceSeed,
        uint8 mode
    ) public {
        entry = bound(entry, 1000, MAX_PRICE);
        // At most 90%, so that every price inside the band is still at least a tenth of the entry and the DEX never
        // rounds a sell to zero
        bandBps = bound(bandBps, 0, 9_000);
        delay = bound(delay, 1, 30 days);
        uint256 positionId = openStagnationPosition(entry, bandBps, delay);

        // delay - 1, delay, or anything up to a day after
        if (mode % 3 == 0) {
            elapsed = delay - 1;
        } else if (mode % 3 == 1) {
            elapsed = delay;
        } else {
            elapsed = bound(elapsed, 0, delay + 1 days);
        }
        uint256 price = pickStagnationPrice(entry, bandBps, priceSeed, (mode / 3) % 5);

        vm.warp(vault.getPosition(positionId).openedAt + elapsed);
        sellForStagnation(positionId, price, bandBps, delay, elapsed);
    }

    function openStagnationPosition(uint256 entry, uint256 bandBps, uint256 delay) internal returns (uint256) {
        IVault.AssetRule memory assetRule = looseEthRule();
        assetRule.stagnationBandBps = uint16(bandBps);
        assetRule.stagnationDelay = uint32(delay);
        setUserEthRule(userRuleOf(BUY, BUY), assetRule);
        return buyEthAt(entry, 1);
    }

    /// @dev The edges of the band, one wei outside each, or any price from 1 wei to three times the entry
    function pickStagnationPrice(uint256 entry, uint256 bandBps, uint256 priceSeed, uint8 priceMode)
        internal
        pure
        returns (uint256)
    {
        uint256 width = entry * bandBps / BPS;
        if (priceMode == 0) return entry - width;
        if (priceMode == 1) return entry + width;
        if (priceMode == 2) return entry - width - 1;
        if (priceMode == 3) return entry + width + 1;
        return bound(priceSeed, 1, 3 * entry);
    }

    function sellForStagnation(uint256 positionId, uint256 price, uint256 bandBps, uint256 delay, uint256 elapsed)
        internal
    {
        IVault.Position memory position = vault.getPosition(positionId);
        IVault.SignedResponse memory response = signedEthPrice(price, block.timestamp);
        uint256 distance = price > position.entryPrice ? price - position.entryPrice : position.entryPrice - price;
        if (elapsed < delay) {
            vm.expectRevert(abi.encodeWithSelector(IVault.StagnationDelayNotOver.selector, position.openedAt + delay));
        } else if (distance * BPS > position.entryPrice * bandBps) {
            vm.expectRevert(
                abi.encodeWithSelector(IVault.PriceOutsideStagnationBand.selector, price, position.entryPrice)
            );
        } else {
            vm.prank(keeper);
            uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Stagnation, response);
            assertFalse(vault.getPosition(positionId).isOpen, "closed");
            assertEq(quoteOut, expectedQuoteOut(position.amount, price, 18), "quote out");
            assertEq(vault.balanceOf(user), DEPOSIT - BUY + quoteOut, "balance");
            return;
        }
        vm.prank(keeper);
        vault.sell(positionId, IVault.SellReason.Stagnation, response);
        assertTrue(vault.getPosition(positionId).isOpen, "still open");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Value
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Buying and selling at the same price never returns more than was paid, and loses at most one unit of
    /// mock USDC to rounding, for any price and any amount
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_BuyThenSellAtTheSamePriceNeverCreatesValue(uint256 price, uint256 amount) public {
        // From 0.001 mock USDC, so that a sell is never rounded to zero and refused by the DEX
        amount = bound(amount, 1000, MAX_AMOUNT);
        price = bound(price, 1000, MAX_PRICE);
        fund(user, amount);
        setUserEthRule(userRuleOf(amount, amount), looseEthRule());
        uint256 balanceBefore = vault.balanceOf(user);

        uint256 positionId = buyEthAt(price, 1);
        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.cost, amount, "cost");
        assertEq(vault.balanceOf(user), balanceBefore - amount, "balance after the buy");

        vm.warp(block.timestamp + 1);
        IVault.SignedResponse memory response = signedEthPrice(price, block.timestamp);
        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, response);

        assertLe(quoteOut, amount, "no value created");
        assertGe(quoteOut + 1, amount, "at most one unit lost");
        assertEq(quoteOut, expectedQuoteOut(position.amount, price, 18), "quote out");
        assertEq(vault.balanceOf(user), balanceBefore - amount + quoteOut, "balance after the sell");
        assertEq(teth.balanceOf(address(vault)), 0, "no asset left");
        assertEq(usdc.balanceOf(address(vault)), vault.balanceOf(user), "the vault holds exactly the balances");
    }
}
