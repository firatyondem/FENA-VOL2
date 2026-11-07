// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Decimals: the vault pays with 6-decimal mock USDC for an 18-decimal asset. A buy and a manual sell at the same
/// price never return more than the buy cost, and lose at most 1 unit of mock USDC (0.000001) to rounding.
/// @dev MockDEX rounds both swaps down: assetOut = quoteIn * 1e30 / price and quoteOut = assetOut * price / 1e30. The
/// first rounding drops less than 1 asset wei, which is worth price / 1e30 units, so for every price up to 1e30 wei
/// (1e12 USD per token) the round trip loses less than 1 unit before the second rounding, and at most 1 unit after it.
contract DecimalsBoundariesTest is UnitBase {
    function setUp() public override {
        super.setUp();
        assertEq(usdc.decimals(), 6);
        assertEq(teth.decimals(), 18);
        // No cooldown and a large budget, so the same user can buy at many prices in a row
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.cooldown = 0;
        setUserEthRule(IVault.Rule({agent: agent, buyAmount: 50e6, maxPerTrade: 50e6, dailyLimit: 1e30}), assetRule);
    }

    /// @dev 50 USDC at 2070 buys 0.024154589371980676 tETH, which sells back for 49.999999 USDC.
    function test_BuyThenSellAtTheSamePrice_LosesExactlyOneUnit() public {
        uint256 positionId = buyEthAt("2000", "2070.000000000000000000");
        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.cost, 50e6);
        assertEq(position.amount, 24154589371980676);
        assertEq(teth.balanceOf(address(vault)), 24154589371980676);

        uint256 quoteOut = sellAtTheSamePrice(positionId, "2070.000000000000000000");
        assertEq(quoteOut, 50e6 - 1);
        assertEq(vault.balanceOf(user), 1_000e6 - 1);
        assertEq(teth.balanceOf(address(vault)), 0);
        // Every mock USDC that the vault holds is the user's free balance.
        assertEq(usdc.balanceOf(address(vault)), vault.balanceOf(user));
    }

    /// @dev 50 USDC at 2048 buys exactly 0.0244140625 tETH, so neither swap rounds.
    function test_BuyThenSellAtTheSamePrice_LosesNothingWhenThePriceDividesEvenly() public {
        uint256 positionId = buyEthAt("1980", "2048.000000000000000000");
        assertEq(vault.getPosition(positionId).amount, 24414062500000000);

        uint256 quoteOut = sellAtTheSamePrice(positionId, "2048.000000000000000000");
        assertEq(quoteOut, 50e6);
        assertEq(vault.balanceOf(user), 1_000e6);
        assertEq(usdc.balanceOf(address(vault)), vault.balanceOf(user));
    }

    /// @dev Prices from the lowest that the trend can buy (10 wei) to 1e30 wei, many of them chosen so that both swaps
    /// round, each as close as Pyth can write it
    function test_BuyThenSellAtTheSamePrice_NeverCreatesValueAndLosesAtMostOneUnit() public {
        uint256[10] memory prices = [
            uint256(10),
            17,
            1e18 + 7,
            123456789123456789123,
            2060e18 + 1,
            2070e18,
            3333333333333333333333,
            65537e18 + 12345,
            1e30 - 1,
            1e30
        ];
        uint256 balance = vault.balanceOf(user);

        for (uint256 i; i < prices.length; i++) {
            uint256 p1 = pythPrice(prices[i]);
            // P1 is about 5% above P0, inside the 3% threshold and the 12% cap.
            uint256 p0 = pythPrice(p1 * 10_000 / 10_500);
            uint256 positionId = buyEthAt(decimalString(p0), decimalString(p1));
            uint256 cost = vault.getPosition(positionId).cost;

            uint256 quoteOut = sellAtTheSamePrice(positionId, decimalString(p1));
            assertLe(quoteOut, cost, "a round trip created value");
            assertLe(cost - quoteOut, 1, "a round trip lost more than 1 unit");
            balance = balance - cost + quoteOut;
            assertEq(vault.balanceOf(user), balance);
            assertEq(usdc.balanceOf(address(vault)), balance);
            assertEq(teth.balanceOf(address(vault)), 0);
        }
        assertGe(vault.balanceOf(user), 1_000e6 - prices.length);
    }

    /// @dev 1 unit (0.000001 USDC) at 2070 buys 483091787 tETH wei, which sell back for 0.99999999 units, rounded down to
    /// 0. MockDEX refuses a swap that pays nothing, so the sell reverts instead of closing the position for nothing.
    function test_RevertWhen_AOneUnitPositionSellsAtTheBuyPrice() public {
        setUserEthRule(IVault.Rule({agent: agent, buyAmount: 1, maxPerTrade: 1, dailyLimit: 1}), ethRule());
        uint256 positionId = buyEthAt("2000", "2070.000000000000000000");
        assertEq(vault.getPosition(positionId).amount, 483091787);
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory price = signedPrice("2070.000000000000000000");

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroOutput.selector));
        vault.sell(positionId, IVault.SellReason.Manual, price);

        // The position keeps its tokens, and the user is down at most the 1 unit that the buy cost.
        assertTrue(vault.getPosition(positionId).isOpen);
        assertEq(teth.balanceOf(address(vault)), 483091787);
        assertEq(vault.balanceOf(user), 1_000e6 - 1);
    }

    /// @dev Sells the position by hand, one minute after the buy, at `price`
    function sellAtTheSamePrice(uint256 positionId, string memory price) private returns (uint256 quoteOut) {
        vm.warp(block.timestamp + 1 minutes);
        bytes[] memory response = signedPrice(price);
        vm.prank(user);
        quoteOut = vault.sell(positionId, IVault.SellReason.Manual, response);
        assertFalse(vault.getPosition(positionId).isOpen);
    }
}
