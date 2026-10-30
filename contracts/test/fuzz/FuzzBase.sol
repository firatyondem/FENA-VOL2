// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {RealMocksBase} from "../utils/RealMocksBase.sol";
import {PriceFormat} from "./PriceFormat.sol";

/// @notice Shared helpers of the fuzz suite, on the real MockDEX, MockUSDC and MockAssetToken of RealMocksBase
/// @dev Fuzzed rules go far beyond the asset profiles of the demo, so the suite widens a profile with wideProfile()
/// where the test is about a rule's own decision and not about the profile.
abstract contract FuzzBase is RealMocksBase {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant USDC_UNIT = 1e6;
    uint256 internal constant PRICE_UNIT = 1e18;
    // Highest price that the suite fuzzes: 1e12 USD per whole token, the "1e30" of the spec
    uint256 internal constant MAX_PRICE = 1e30;
    // Most quote tokens that one fuzzed buy spends: 1e9 USDC
    uint256 internal constant MAX_AMOUNT = 1e15;
    // Twitter's snowflake IDs keep 22 bits below the time bits.
    uint256 internal constant SEQUENCE_BITS = 22;

    /// @dev The widest profile that the vault accepts for `profile`'s token and request, so any consistent rule fits
    function wideProfile(IVault.AssetProfile memory profile) internal pure returns (IVault.AssetProfile memory) {
        profile.minThresholdBps = 1;
        profile.maxSpikeCapBps = type(uint16).max;
        profile.minWait = 1;
        profile.maxWindow = 365 days;
        return profile;
    }

    function useWideEthProfile() internal {
        vault.setAssetProfile(ETH, wideProfile(ethProfile()));
    }

    /// @dev An ETH rule that the wide profile accepts: +0.01% threshold, the highest spike cap, 1 s -> 1 day, no
    /// cooldown, the whole daily limit, take-profit and stagnation exit off
    function looseEthRule() internal pure returns (IVault.AssetRule memory) {
        return IVault.AssetRule({
            thresholdBps: 1,
            spikeCapBps: type(uint16).max,
            minWait: 1,
            maxWindow: 1 days,
            cooldown: 0,
            budgetShareBps: uint16(BPS),
            takeProfitBps: 0,
            stagnationBandBps: 0,
            stagnationDelay: 0
        });
    }

    /// @dev Sets the user's rule with ETH as the only asset. Leaves the prank alone, so call it outside of one.
    function setUserEthRule(IVault.Rule memory userRule, IVault.AssetRule memory assetRule) internal {
        vm.prank(user);
        vault.setRule(userRule, one(ETH), oneRule(assetRule), topics(1), watched());
    }

    /// @dev A rule of the user's agent that buys `amount` per trade, at most `amount` per trade and `dailyLimit` per day
    function userRuleOf(uint256 amount, uint256 dailyLimit) internal view returns (IVault.Rule memory) {
        return IVault.Rule({agent: agent, buyAmount: amount, maxPerTrade: amount, dailyLimit: dailyLimit});
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Signed prices from uint256 values
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev An ETH price that the source took at `updatedAt` (seconds) and the Airnode signed now
    function signedEthPrice(uint256 price, uint256 updatedAt) internal view returns (IVault.SignedResponse memory) {
        return signedPriceAt(PriceFormat.format(price), updatedAt);
    }

    /// @dev A price for `requestHash` with "updatedAt" written exactly as `updatedAtField`, signed now
    function signedPriceRaw(bytes32 requestHash, uint256 price, uint256 updatedAtField)
        internal
        view
        returns (IVault.SignedResponse memory)
    {
        bytes memory data = bytes(
            string.concat('{"price":', PriceFormat.format(price), ',"updatedAt":', vm.toString(updatedAtField), "}")
        );
        return sign(priceAirnodeKey, requestHash, block.timestamp, data);
    }

    /// @dev A tweet ID whose time bits say `createdAtMs` milliseconds and whose low bits are `sequence`
    function tweetIdAtMs(uint256 createdAtMs, uint256 sequence) internal pure returns (uint256) {
        return ((createdAtMs - TWITTER_EPOCH_MS) << SEQUENCE_BITS) | sequence;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Flow
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Opens an ETH trigger for the user: a post now and P0 = `p0` one minute later. Leaves the clock at t0.
    function openEthAt(uint256 p0) internal returns (uint256 triggerId, uint256 t0) {
        triggerId = openEthTrigger(PriceFormat.format(p0));
        t0 = block.timestamp;
    }

    /// @dev Highest P0 that a P1 of `entry` confirms with a threshold of `thresholdBps`
    function p0Below(uint256 entry, uint256 thresholdBps) internal pure returns (uint256) {
        return entry * BPS / (BPS + thresholdBps);
    }

    /// @dev Buys ETH at exactly `entry` under looseEthRule()-like limits (threshold 1 bps, wait 1 s): opens a trigger,
    /// waits `wait` and confirms at P1 = `entry`, taken and signed at the time of the buy
    function buyEthAt(uint256 entry, uint256 wait) internal returns (uint256 positionId) {
        (uint256 triggerId, uint256 t0) = openEthAt(p0Below(entry, 1));
        vm.warp(t0 + wait);
        IVault.SignedResponse memory p1 = signedEthPrice(entry, block.timestamp);
        vm.prank(keeper);
        positionId = vault.confirmTrigger(triggerId, p1);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Expected values, written from IMockDEX's formulas
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev assetOut = quoteIn * 10**assetDecimals * 1e18 / (price * 10**quoteDecimals), rounded down
    function expectedAssetOut(uint256 quoteIn, uint256 price, uint8 assetDecimals) internal pure returns (uint256) {
        return quoteIn * 10 ** assetDecimals * PRICE_UNIT / (price * USDC_UNIT);
    }

    /// @dev quoteOut = assetIn * price * 10**quoteDecimals / (10**assetDecimals * 1e18), rounded down
    function expectedQuoteOut(uint256 assetIn, uint256 price, uint8 assetDecimals) internal pure returns (uint256) {
        return assetIn * price * USDC_UNIT / (10 ** assetDecimals * PRICE_UNIT);
    }

    function triggerStatus(uint256 triggerId) internal view returns (IVault.TriggerStatus) {
        return vault.getTrigger(triggerId).status;
    }

    function assertTriggerStatus(uint256 triggerId, IVault.TriggerStatus expected) internal view {
        assertEq(uint256(triggerStatus(triggerId)), uint256(expected), "trigger status");
    }
}
