// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FuzzBase} from "./FuzzBase.sol";

/// @notice Freshness for any times: a P1 or sell price is accepted for exactly the profile's maxPriceAge after Pyth
/// published it (the market-hours check), a post for exactly MAX_POST_AGE, and P0 only when it is the first price
/// published at or after the post and at most MAX_POST_TO_P0 after it
contract FreshnessFuzzTest is FuzzBase {
    function setUp() public override {
        super.setUp();
        useWideEthProfile();
        setUserEthRule(userRuleOf(50e6, 1_000e6), looseEthRule());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Price age: rejected exactly when publishTime + maxPriceAge < block.timestamp
    // ---------------------------------------------------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PriceAgeOfP1(uint256 maxPriceAge, uint256 lag, uint8 mode) public {
        maxPriceAge = useFuzzedPriceAge(maxPriceAge);
        (uint256 triggerId, uint256 t0) = openEthAt(2000e18);
        vm.warp(t0 + 3 hours);
        lag = pickLag(lag, mode, maxPriceAge);
        uint256 t1 = block.timestamp - lag;
        bytes[] memory p1 = signedEthPrice(2070e18, t1);

        if (lag > maxPriceAge) vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, t1));
        vault.confirmTrigger(triggerId, p1);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PriceAgeOfASellPrice(uint256 maxPriceAge, uint256 lag, uint8 mode, uint256 hold) public {
        maxPriceAge = useFuzzedPriceAge(maxPriceAge);
        uint256 positionId = buyEthAt(2070e18, 1);
        uint256 boughtAt = block.timestamp;
        hold = bound(hold, 2 hours, 30 days);
        vm.warp(boughtAt + hold);
        lag = pickLag(lag, mode, maxPriceAge);
        uint256 priceTime = block.timestamp - lag;
        bytes[] memory price = signedEthPrice(1900e18, priceTime);

        if (lag > maxPriceAge) vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, priceTime));
        vm.prank(user);
        vault.sell(positionId, IVault.SellReason.Manual, price);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Post age: rejected exactly when tweetTime + MAX_POST_AGE < block.timestamp, or tweetTime > block.timestamp
    // ---------------------------------------------------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PostAge(uint256 age, uint8 mode) public {
        uint256 maxAge = vault.MAX_POST_AGE();
        if (mode % 3 == 0) age = maxAge;
        else if (mode % 3 == 1) age = maxAge + 1;
        else age = bound(age, 0, 2 * maxAge);
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + age);
        // P0 a second after the post, so only the post's age decides
        bytes[] memory p0 = signedEthPrice(2000e18, postedAt + 1);

        if (age > maxAge) vm.expectRevert(abi.encodeWithSelector(IVault.PostOutsideWindow.selector, postedAt));
        vm.prank(agent);
        vault.openTrigger(user, ETH, ACCOUNT, tweetIdAt(postedAt), p0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Post to P0: tweetTime <= t0 <= tweetTime + MAX_POST_TO_P0, with tweetTime from the snowflake ID
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice tweetTime = ((id >> 22) + 1288834974657) / 1000 for any sequence bits, and P0 opens a trigger exactly
    /// when it was published no earlier than the post and at most ten minutes after it
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PostToP0WindowEqualsTheFormula(uint256 createdAtMs, uint256 sequence, uint8 mode) public {
        uint256 now_ = block.timestamp;
        createdAtMs = bound(createdAtMs, (now_ - 25 minutes) * 1000, now_ * 1000 + 999);
        sequence = bound(sequence, 0, (1 << SEQUENCE_BITS) - 1);
        uint256 tweetTime = createdAtMs / 1000;
        vm.assume(tweetTime <= now_);
        uint256 tweetId = tweetIdAtMs(createdAtMs, sequence);
        assertEq(((tweetId >> SEQUENCE_BITS) + TWITTER_EPOCH_MS) / 1000, tweetTime, "snowflake time");

        uint256 t0;
        if (mode % 4 == 0) t0 = tweetTime + vault.MAX_POST_TO_P0();
        else if (mode % 4 == 1) t0 = tweetTime + vault.MAX_POST_TO_P0() + 1;
        else if (mode % 4 == 2) t0 = tweetTime;
        else t0 = tweetTime - 1;
        bytes[] memory p0 = signedEthPrice(2000e18, t0);

        bool inside = t0 >= tweetTime && t0 <= tweetTime + vault.MAX_POST_TO_P0();
        if (!inside) {
            vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, tweetTime, t0));
        }
        vm.prank(agent);
        vault.openTrigger(user, ETH, ACCOUNT, tweetId, p0);
    }

    /// @notice P0 opens a trigger exactly when Pyth's previous price for the feed came before the post
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_P0MustBeTheFirstPriceAfterThePost(uint256 delay, uint256 prevBefore) public {
        uint256 postedAt = block.timestamp;
        delay = bound(delay, 0, vault.MAX_POST_TO_P0());
        uint256 t0 = postedAt + delay;
        // Pyth's previous price: anywhere from a minute before the post to just before P0
        uint64 prev = uint64(bound(prevBefore, postedAt - 1 minutes, t0 - 1));
        vm.warp(t0 + 1);
        bytes[] memory p0 = priceUpdate18(ETH_FEED, 2000e18, t0, prev);

        if (prev >= postedAt) {
            vm.expectRevert(abi.encodeWithSelector(IVault.PriceNotFirstAfterPost.selector, postedAt, t0));
        }
        vm.prank(agent);
        vault.openTrigger(user, ETH, ACCOUNT, tweetIdAt(postedAt), p0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Sets a wide ETH profile with a fuzzed maxPriceAge of 1 s to an hour
    function useFuzzedPriceAge(uint256 maxPriceAge) private returns (uint256) {
        maxPriceAge = bound(maxPriceAge, 1, 1 hours);
        IVault.AssetProfile memory profile = wideProfile(ethProfile());
        profile.maxPriceAge = uint32(maxPriceAge);
        vault.setAssetProfile(ETH, profile);
        return maxPriceAge;
    }

    /// @dev maxPriceAge or maxPriceAge + 1, or anywhere up to an hour beyond it
    function pickLag(uint256 lag, uint8 mode, uint256 maxPriceAge) private pure returns (uint256) {
        if (mode % 3 == 0) return maxPriceAge;
        if (mode % 3 == 1) return maxPriceAge + 1;
        return bound(lag, 0, maxPriceAge + 1 hours);
    }
}
