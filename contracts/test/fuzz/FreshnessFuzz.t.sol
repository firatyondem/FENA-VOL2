// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FuzzBase} from "./FuzzBase.sol";

/// @notice Freshness of signed data for any times: a response is accepted for exactly MAX_RESPONSE_AGE after the
/// Airnode signed it, a price for exactly the profile's maxPriceAge after the source took it (the market-hours check),
/// and P0 only within MAX_POST_TO_P0 after the post. Each holds for the post, P0, P1 and a sell price alike.
contract FreshnessFuzzTest is FuzzBase {
    string constant ETH_USD_FIXTURE = "../shared/fixtures/nodary-eth-usd.json";
    bytes32 constant NODARY_ETH = keccak256("NODARY ETH");
    uint256 constant DEPOSIT = 1_000e6;

    uint256 maxResponseAge;
    uint256 maxPostToP0;

    function setUp() public override {
        super.setUp();
        maxResponseAge = vault.MAX_RESPONSE_AGE();
        maxPostToP0 = vault.MAX_POST_TO_P0();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Response age: rejected exactly when timestamp + MAX_RESPONSE_AGE < block.timestamp
    // ---------------------------------------------------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ResponseAgeOfThePost(uint256 start, uint256 age) public {
        vm.warp(block.timestamp + bound(start, 0, 365 days));
        age = bound(age, 0, 2 * maxResponseAge);
        uint256 signedAt = block.timestamp;
        IVault.SignedResponse memory tweet = signedTweet(signedAt);
        vm.warp(signedAt + age);
        // P0 is fresh and within ten minutes of the post.
        IVault.SignedResponse memory p0 = signedEthPrice(2000e18, block.timestamp);

        vm.prank(agent);
        if (signedAt + maxResponseAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
            vault.openTrigger(user, ETH, tweet, p0);
            assertEq(vault.triggerCount(), 0);
        } else {
            vault.openTrigger(user, ETH, tweet, p0);
            assertEq(vault.triggerCount(), 1);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ResponseAgeOfP0(uint256 start, uint256 age) public {
        useLongPriceAge();
        vm.warp(block.timestamp + bound(start, 0, 365 days));
        age = bound(age, 0, 2 * maxResponseAge);
        uint256 signedAt = block.timestamp;
        IVault.SignedResponse memory p0 = signedEthPrice(2000e18, signedAt);
        vm.warp(signedAt + age);
        IVault.SignedResponse memory tweet = signedTweet(signedAt - 1 minutes);

        vm.prank(agent);
        if (signedAt + maxResponseAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
            vault.openTrigger(user, ETH, tweet, p0);
            assertEq(vault.triggerCount(), 0);
        } else {
            vault.openTrigger(user, ETH, tweet, p0);
            assertEq(vault.triggerCount(), 1);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ResponseAgeOfP1(uint256 start, uint256 age) public {
        useLongPriceAge();
        vm.warp(block.timestamp + bound(start, 0, 365 days));
        age = bound(age, 0, 2 * maxResponseAge);
        (uint256 triggerId, uint256 t0) = openEthAt(2000e18);
        uint256 signedAt = t0 + 31 minutes;
        vm.warp(signedAt);
        IVault.SignedResponse memory p1 = signedEthPrice(2070e18, signedAt);
        vm.warp(signedAt + age);

        if (signedAt + maxResponseAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
            vault.confirmTrigger(triggerId, p1);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
            assertEq(vault.balanceOf(user), DEPOSIT);
        } else {
            vault.confirmTrigger(triggerId, p1);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ResponseAgeOfASellPrice(uint256 start, uint256 hold, uint256 age) public {
        useLongPriceAge();
        vm.warp(block.timestamp + bound(start, 0, 365 days));
        age = bound(age, 0, 2 * maxResponseAge);
        uint256 positionId = buyEth();
        uint256 signedAt = block.timestamp + bound(hold, 0, 30 days);
        vm.warp(signedAt);
        IVault.SignedResponse memory price = signedEthPrice(1900e18, signedAt);
        vm.warp(signedAt + age);

        vm.prank(user);
        if (signedAt + maxResponseAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
            vault.sell(positionId, IVault.SellReason.Manual, price);
            assertTrue(vault.getPosition(positionId).isOpen);
        } else {
            vault.sell(positionId, IVault.SellReason.Manual, price);
            assertFalse(vault.getPosition(positionId).isOpen);
        }
    }

    /// @notice The same rule on a real response that the Nodary Airnode signed
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ResponseAgeOfARealNodaryPrice(uint256 age) public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(ETH_USD_FIXTURE);
        IVault.SignedResponse memory real = IVault.SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
        IVault.AssetProfile memory profile = ethProfile();
        profile.airnode = vm.parseJsonAddress(json, ".airnode");
        profile.priceRequestHash = real.requestHash;
        // Long enough that only the response age decides
        profile.maxPriceAge = 1 days;
        vault.setAssetProfile(NODARY_ETH, profile);
        vm.prank(user);
        vault.setRule(rule(), one(NODARY_ETH), oneRule(ethRule()), topics(1), watched());

        age = bound(age, 0, 2 * maxResponseAge);
        vm.warp(real.timestamp + age);
        // The fixture's price was taken at updatedAt 1793381072608 ms, so a post one minute before it
        IVault.SignedResponse memory tweet = signedTweet(real.timestamp - 1 minutes);

        vm.prank(agent);
        if (real.timestamp + maxResponseAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, real.timestamp));
            vault.openTrigger(user, NODARY_ETH, tweet, real);
        } else {
            uint256 triggerId = vault.openTrigger(user, NODARY_ETH, tweet, real);
            assertEq(vault.getTrigger(triggerId).p0, 2244.695e18);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Price age (market hours): rejected exactly when priceTime + maxPriceAge < block.timestamp
    // ---------------------------------------------------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PriceAgeOfP0(uint256 maxPriceAge, uint256 lag, uint256 millis, bool inMs, uint8 mode) public {
        maxPriceAge = useFuzzedPriceAge(maxPriceAge, inMs);
        lag = pickLag(lag, mode, maxPriceAge);
        uint256 priceTime = block.timestamp;
        vm.warp(priceTime + lag);
        // A fresh signature over a price that the source took `lag` ago, and a post at the time of the price
        IVault.SignedResponse memory p0 =
            signedPriceRaw(ETH_PRICE_REQUEST, 2000e18, updatedAtField(priceTime, millis, inMs));
        IVault.SignedResponse memory tweet = signedTweet(priceTime);

        vm.prank(agent);
        if (priceTime + maxPriceAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, priceTime));
            vault.openTrigger(user, ETH, tweet, p0);
            assertEq(vault.triggerCount(), 0);
        } else {
            uint256 triggerId = vault.openTrigger(user, ETH, tweet, p0);
            assertEq(vault.getTrigger(triggerId).t0, priceTime, "t0 in whole seconds");
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PriceAgeOfP1(uint256 maxPriceAge, uint256 lag, uint256 millis, bool inMs, uint8 mode) public {
        maxPriceAge = useFuzzedPriceAge(maxPriceAge, inMs);
        lag = pickLag(lag, mode, maxPriceAge);
        IVault.AssetRule memory assetRule = looseEthRule();
        setUserEthRule(rule(), assetRule);
        uint256 t0 = block.timestamp;
        uint256 triggerId = openRaw(t0);

        uint256 t1 = t0 + 1 hours;
        vm.warp(t1 + lag);
        IVault.SignedResponse memory p1 = signedPriceRaw(ETH_PRICE_REQUEST, 2070e18, updatedAtField(t1, millis, inMs));

        if (t1 + maxPriceAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, t1));
            vault.confirmTrigger(triggerId, p1);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
            assertEq(vault.balanceOf(user), DEPOSIT);
        } else {
            vault.confirmTrigger(triggerId, p1);
            assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PriceAgeOfASellPrice(
        uint256 maxPriceAge,
        uint256 hold,
        uint256 lag,
        uint256 millis,
        bool inMs,
        uint8 mode
    ) public {
        maxPriceAge = useFuzzedPriceAge(maxPriceAge, inMs);
        lag = pickLag(lag, mode, maxPriceAge);
        setUserEthRule(rule(), looseEthRule());
        uint256 t0 = block.timestamp;
        uint256 triggerId = openRaw(t0);
        vm.warp(t0 + 1);
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(
            triggerId, signedPriceRaw(ETH_PRICE_REQUEST, 2070e18, updatedAtField(block.timestamp, 0, inMs))
        );

        uint256 priceTime = block.timestamp + bound(hold, 0, 30 days);
        vm.warp(priceTime + lag);
        IVault.SignedResponse memory price =
            signedPriceRaw(ETH_PRICE_REQUEST, 1900e18, updatedAtField(priceTime, millis, inMs));

        vm.prank(user);
        if (priceTime + maxPriceAge < block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, priceTime));
            vault.sell(positionId, IVault.SellReason.Manual, price);
            assertTrue(vault.getPosition(positionId).isOpen);
        } else {
            vault.sell(positionId, IVault.SellReason.Manual, price);
            assertFalse(vault.getPosition(positionId).isOpen);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Post to P0: tweetTime <= t0 <= tweetTime + MAX_POST_TO_P0, with tweetTime from the snowflake ID
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice tweetTime = ((id >> 22) + 1288834974657) / 1000 for any sequence bits, and P0 opens a trigger exactly
    /// when it was taken no earlier than the post and at most ten minutes after it
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PostToP0WindowEqualsTheFormula(uint256 createdAtMs, uint256 sequence, uint8 mode) public {
        uint256 t0 = block.timestamp;
        uint256 millis = createdAtMs % 1000;
        if (mode % 5 == 1) {
            // Exactly ten minutes before P0, or one second more
            createdAtMs = (t0 - maxPostToP0) * 1000 + millis;
        } else if (mode % 5 == 2) {
            createdAtMs = (t0 - maxPostToP0 - 1) * 1000 + millis;
        } else if (mode % 5 == 3) {
            // In the same second as P0, or one second after it
            createdAtMs = t0 * 1000 + millis;
        } else if (mode % 5 == 4) {
            createdAtMs = (t0 + 1) * 1000 + millis;
        } else {
            createdAtMs = bound(createdAtMs, (t0 - 20 minutes) * 1000, (t0 + 5 minutes) * 1000);
        }
        sequence = bound(sequence, 0, (1 << SEQUENCE_BITS) - 1);
        uint256 tweetId = tweetIdAtMs(createdAtMs, sequence);
        uint256 tweetTime = createdAtMs / 1000;

        IVault.SignedResponse memory tweet = signedTweetWithId(ACCOUNT, tweetId);
        IVault.SignedResponse memory p0 = signedEthPrice(2000e18, t0);

        vm.prank(agent);
        if (t0 < tweetTime || t0 > tweetTime + maxPostToP0) {
            vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, tweetTime, t0));
            vault.openTrigger(user, ETH, tweet, p0);
            assertEq(vault.triggerCount(), 0);
        } else {
            uint256 triggerId = vault.openTrigger(user, ETH, tweet, p0);
            IVault.Trigger memory trigger = vault.getTrigger(triggerId);
            assertEq(trigger.tweetId, tweetId, "tweet ID");
            assertEq(trigger.t0, t0, "t0");
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A price age of a day, so that only the response age decides
    function useLongPriceAge() private {
        IVault.AssetProfile memory profile = ethProfile();
        profile.maxPriceAge = 1 days;
        vault.setAssetProfile(ETH, profile);
    }

    /// @dev Sets a wide ETH profile with a fuzzed maxPriceAge, in seconds or milliseconds
    function useFuzzedPriceAge(uint256 maxPriceAge, bool inMs) private returns (uint256) {
        maxPriceAge = bound(maxPriceAge, 1, 1 days);
        IVault.AssetProfile memory profile = wideProfile(ethProfile());
        profile.maxPriceAge = uint32(maxPriceAge);
        profile.updatedAtInMs = inMs;
        vault.setAssetProfile(ETH, profile);
        return maxPriceAge;
    }

    /// @dev maxPriceAge or maxPriceAge + 1, or anywhere up to an hour beyond it
    function pickLag(uint256 lag, uint8 mode, uint256 maxPriceAge) private pure returns (uint256) {
        if (mode % 2 == 1) return maxPriceAge + lag % 2;
        return bound(lag, 0, maxPriceAge + 1 hours);
    }

    /// @dev "updatedAt" for a price taken at `priceTime`: milliseconds with up to 999 more, or plain seconds
    function updatedAtField(uint256 priceTime, uint256 millis, bool inMs) private pure returns (uint256) {
        return inMs ? priceTime * 1000 + millis % 1000 : priceTime;
    }

    /// @dev Opens an ETH trigger with P0 = 2000, taken at `t0` and signed now, and a post at `t0`
    function openRaw(uint256 t0) private returns (uint256 triggerId) {
        bool inMs = vault.getAssetProfile(ETH).updatedAtInMs;
        IVault.SignedResponse memory p0 = signedPriceRaw(ETH_PRICE_REQUEST, 2000e18, updatedAtField(t0, 0, inMs));
        IVault.SignedResponse memory tweet = signedTweet(t0);
        vm.prank(agent);
        triggerId = vault.openTrigger(user, ETH, tweet, p0);
    }
}
