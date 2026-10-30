// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {FuzzBase} from "./FuzzBase.sol";

/// @notice Gate 2 decides as the spec's formulas say for any prices, thresholds, caps and times: P0 * (1 + threshold)
/// <= P1 <= P0 * (1 + spike cap), minWait <= t1 - t0 <= maxWindow, and a trigger expires only after t0 + maxWindow
contract GateTwoFuzzTest is FuzzBase {
    uint256 constant BUY = 50e6;
    uint256 constant DEPOSIT = 1_000e6;

    function setUp() public override {
        super.setUp();
        useWideEthProfile();
    }

    /// @notice Whether P1 buys, is too weak or spikes too high equals P1 >= P0 * (1 + threshold) and
    /// P1 <= P0 * (1 + cap), for prices from 1 wei to 1e30 and every threshold and cap a uint16 holds
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_TrendAndSpikeDecisionEqualsTheFormula(
        uint256 p0,
        uint256 p1Seed,
        uint256 thresholdBps,
        uint256 spikeCapBps,
        uint8 mode
    ) public {
        thresholdBps = bound(thresholdBps, 1, type(uint16).max);
        spikeCapBps = bound(spikeCapBps, thresholdBps, type(uint16).max);
        p0 = bound(p0, 1, MAX_PRICE);
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.thresholdBps = uint16(thresholdBps);
        assetRule.spikeCapBps = uint16(spikeCapBps);
        vm.prank(user);
        setEthRule(assetRule);

        // The lowest P1 that reaches P0 * (1 + threshold) and the highest that stays at or below P0 * (1 + cap)
        uint256 lowest = Math.ceilDiv(p0 * (BPS + thresholdBps), BPS);
        uint256 highest = p0 * (BPS + spikeCapBps) / BPS;
        uint256 p1 = pickP1(p1Seed, mode, lowest, highest);

        (uint256 triggerId, uint256 t0) = openEthAt(p0);
        vm.warp(t0 + assetRule.minWait);
        IVault.SignedResponse memory response = signedEthPrice(p1, block.timestamp);

        if (p1 < lowest) {
            vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, p0, p1));
            vault.confirmTrigger(triggerId, response);
            assertNothingBought(triggerId);
        } else if (p1 > highest) {
            vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, p0, p1));
            vault.confirmTrigger(triggerId, response);
            assertNothingBought(triggerId);
        } else {
            uint256 positionId = vault.confirmTrigger(triggerId, response);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
            IVault.Position memory position = vault.getPosition(positionId);
            assertEq(position.entryPrice, p1, "entry is P1");
            assertEq(position.cost, BUY, "cost");
            assertEq(position.amount, expectedAssetOut(BUY, p1, 18), "asset out");
            assertEq(teth.balanceOf(address(vault)), position.amount, "vault holds the asset");
            assertEq(vault.balanceOf(user), DEPOSIT - BUY, "balance");
        }
    }

    /// @notice Whether P1 is too early, too late or in time equals minWait <= t1 - t0 <= maxWindow, where t1 is the
    /// time at which the source took P1, not the time of the confirmation
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_WindowDecisionEqualsTheFormula(
        uint256 minWait,
        uint256 maxWindow,
        uint256 elapsed,
        uint256 lag,
        uint8 mode
    ) public {
        minWait = bound(minWait, 1, 30 days);
        maxWindow = bound(maxWindow, minWait, 365 days);
        IVault.AssetRule memory assetRule = ethRule();
        assetRule.minWait = uint32(minWait);
        assetRule.maxWindow = uint32(maxWindow);
        vm.prank(user);
        setEthRule(assetRule);

        if (mode % 3 == 1) {
            // minWait - 1 or minWait
            elapsed = minWait - 1 + elapsed % 2;
        } else if (mode % 3 == 2) {
            // maxWindow or maxWindow + 1
            elapsed = maxWindow + elapsed % 2;
        } else {
            elapsed = bound(elapsed, 0, maxWindow + 1 days);
        }
        // The price can be up to maxPriceAge old when it arrives.
        lag = bound(lag, 0, ethProfile().maxPriceAge);

        (uint256 triggerId, uint256 t0) = openEthAt(2000e18);
        uint256 t1 = t0 + elapsed;
        vm.warp(t1 + lag);
        // +3.5%, inside the threshold and the cap
        IVault.SignedResponse memory p1 = signedEthPrice(2070e18, t1);

        if (t1 - t0 < minWait) {
            vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, t0 + minWait));
            vault.confirmTrigger(triggerId, p1);
            assertNothingBought(triggerId);
        } else if (t1 - t0 > maxWindow) {
            vm.expectRevert(abi.encodeWithSelector(IVault.WindowClosed.selector, t0 + maxWindow));
            vault.confirmTrigger(triggerId, p1);
            assertNothingBought(triggerId);
        } else {
            vault.confirmTrigger(triggerId, p1);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
            assertEq(vault.balanceOf(user), DEPOSIT - BUY, "balance");
        }
    }

    /// @notice expireTrigger closes a trigger exactly when block.timestamp > t0 + maxWindow, moves nothing, and the
    /// expired trigger never buys
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ExpireDecisionEqualsTheFormula(uint256 maxWindow, uint256 wait, uint8 mode) public {
        maxWindow = bound(maxWindow, 1, 365 days);
        IVault.AssetRule memory assetRule = looseEthRule();
        assetRule.maxWindow = uint32(maxWindow);
        setUserEthRule(rule(), assetRule);

        // maxWindow or maxWindow + 1 after t0, or anywhere up to two days after the deadline
        wait = mode % 2 == 1 ? maxWindow + wait % 2 : bound(wait, 0, maxWindow + 2 days);

        (uint256 triggerId, uint256 t0) = openEthAt(2000e18);
        uint256 deadline = t0 + maxWindow;
        vm.warp(t0 + wait);

        if (block.timestamp <= deadline) {
            vm.expectRevert(abi.encodeWithSelector(IVault.WindowNotClosed.selector, deadline));
            vm.prank(keeper);
            vault.expireTrigger(triggerId);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        } else {
            vm.expectEmit(address(vault));
            emit IVault.TriggerExpired(triggerId);
            vm.prank(keeper);
            vault.expireTrigger(triggerId);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Expired);

            // An expired trigger never buys, even with a P1 that would have passed in the window.
            IVault.SignedResponse memory p1 = signedEthPrice(2070e18, block.timestamp);
            vm.expectRevert(abi.encodeWithSelector(IVault.TriggerNotOpen.selector, triggerId));
            vault.confirmTrigger(triggerId, p1);
        }
        assertEq(vault.balanceOf(user), DEPOSIT, "balance");
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT, "vault USDC");
        assertEq(teth.balanceOf(address(vault)), 0, "vault asset");
    }

    /// @notice A P1 of 0 never buys: it is always too weak
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_AZeroP1NeverBuys(uint256 p0, uint256 thresholdBps) public {
        p0 = bound(p0, 1, MAX_PRICE);
        thresholdBps = bound(thresholdBps, 1, type(uint16).max);
        IVault.AssetRule memory assetRule = looseEthRule();
        assetRule.thresholdBps = uint16(thresholdBps);
        setUserEthRule(rule(), assetRule);

        (uint256 triggerId, uint256 t0) = openEthAt(p0);
        vm.warp(t0 + 1);
        IVault.SignedResponse memory p1 = signedEthPrice(0, block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(IVault.TrendTooWeak.selector, p0, 0));
        vault.confirmTrigger(triggerId, p1);
        assertNothingBought(triggerId);
    }

    /// @notice A trigger with a P0 of 0 never buys: any P1 above 0 spikes past the cap, and a P1 of 0 stops at the
    /// DEX's ZeroPrice
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_AZeroP0NeverBuys(uint256 p1) public {
        p1 = bound(p1, 0, MAX_PRICE);
        setUserEthRule(rule(), looseEthRule());

        (uint256 triggerId, uint256 t0) = openEthAt(0);
        vm.warp(t0 + 1);
        IVault.SignedResponse memory response = signedEthPrice(p1, block.timestamp);

        if (p1 == 0) {
            vm.expectRevert(abi.encodeWithSelector(MockDEX.ZeroPrice.selector));
        } else {
            vm.expectRevert(abi.encodeWithSelector(IVault.SpikeTooHigh.selector, 0, p1));
        }
        vault.confirmTrigger(triggerId, response);
        assertNothingBought(triggerId);
    }

    /// @dev Exercises the edges far more often than a uniform draw would: one unit around the lowest P1 that passes,
    /// one unit around the highest, anywhere in between, or anywhere from 0 to twice the highest
    function pickP1(uint256 seed, uint8 mode, uint256 lowest, uint256 highest) private pure returns (uint256) {
        if (mode % 4 == 1) return nearby(lowest, seed);
        if (mode % 4 == 2) return nearby(highest, seed);
        if (mode % 4 == 3 && lowest <= highest) return bound(seed, lowest, highest);
        return bound(seed, 0, 2 * highest + 2);
    }

    /// @dev edge - 2 to edge + 2, never below 0
    function nearby(uint256 edge, uint256 seed) private pure returns (uint256) {
        uint256 shifted = edge + seed % 5;
        return shifted < 2 ? 0 : shifted - 2;
    }

    function assertNothingBought(uint256 triggerId) private view {
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(vault.balanceOf(user), DEPOSIT, "balance");
        assertEq(vault.spentToday(user, ETH), 0, "spent");
        assertEq(vault.positionCount(), 0, "positions");
        assertEq(teth.balanceOf(address(vault)), 0, "vault asset");
    }
}
