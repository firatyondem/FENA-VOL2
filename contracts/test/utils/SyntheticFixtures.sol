// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PythTestKit} from "./PythTestKit.sol";

/// @notice The synthetic cases of the hackathon's signed fixtures, as Pyth updates: one post of each watched account, an
/// ETH and an oil P0, P1s that rise, stay flat, spike or come early or late, and the four tamper cases
/// @dev The times and prices are those of shared/fixtures/synthetic. Real Pyth signatures are tested on a fork, with
/// real Hermes payloads (test/fork/PythFork.t.sol).
abstract contract SyntheticFixtures is PythTestKit {
    uint256 internal constant TWEET_CREATED_AT = 1793380800;
    // P0: two minutes after the post
    uint256 internal constant T0 = 1793380920;
    uint256 internal constant T1_EARLY = 1793380980;
    uint256 internal constant T1 = 1793381220;
    uint256 internal constant T1_LATE = 1793381820;
    // A day before T1
    uint256 internal constant STALE_TIME = 1793294519;
    uint256 internal constant OLD_TWEET_CREATED_AT = 1793208000;

    uint256 internal constant TRUMP_TWEET_ID = 2116218573419446273;
    uint256 internal constant MUSK_TWEET_ID = 2116218573419446274;
    uint256 internal constant OLD_TWEET_ID = 2115493797688246275;

    bytes32 internal constant trumpAccount = ACCOUNT;
    bytes32 internal constant muskAccount = OTHER_ACCOUNT;

    /// @dev A post fixture: tweet-trump-venezuela, tweet-musk-doge or tweet-trump-old
    function fixtureTweet(string memory name) internal pure returns (Post memory) {
        bytes32 key = keccak256(bytes(name));
        if (key == keccak256("tweet-trump-venezuela")) return Post(ACCOUNT, TRUMP_TWEET_ID);
        if (key == keccak256("tweet-musk-doge")) return Post(OTHER_ACCOUNT, MUSK_TWEET_ID);
        if (key == keccak256("tweet-trump-old")) return Post(ACCOUNT, OLD_TWEET_ID);
        revert(string.concat("no post fixture ", name));
    }

    /// @dev A price fixture, by the name of its old signed file
    function fixture(string memory name) internal pure returns (bytes[] memory) {
        bytes32 key = keccak256(bytes(name));
        if (key == keccak256("eth-p0")) return signedPriceOf(ETH_FEED, "2000", T0);
        if (key == keccak256("eth-p1-early")) return signedPriceOf(ETH_FEED, "2070", T1_EARLY);
        if (key == keccak256("eth-p1-flat")) return signedPriceOf(ETH_FEED, "2010", T1);
        if (key == keccak256("eth-p1-late")) return signedPriceOf(ETH_FEED, "2070", T1_LATE);
        if (key == keccak256("eth-p1-rise")) return signedPriceOf(ETH_FEED, "2070", T1);
        if (key == keccak256("eth-p1-spike")) return signedPriceOf(ETH_FEED, "2300", T1);
        if (key == keccak256("oil-p0")) return signedPriceOf(OIL_FEED, "70.25", T0);
        if (key == keccak256("oil-p1-rise")) return signedPriceOf(OIL_FEED, "71.4", T1);
        // A genuine price of another feed
        if (key == keccak256("tamper-different-request")) return signedPriceOf(BTC_FEED, "80000", T1);
        // eth-p1-rise with its price raised to 2170 after signing: Pyth refuses it
        if (key == keccak256("tamper-edited-value")) return edited(signedPriceOf(ETH_FEED, "2170", T1));
        // A genuine price from a day earlier
        if (key == keccak256("tamper-stale")) return signedPriceOf(ETH_FEED, "2070", STALE_TIME);
        // eth-p1-rise as someone else signed it: Pyth refuses it
        if (key == keccak256("tamper-wrong-signer")) return edited(signedPriceOf(ETH_FEED, "2070", T1));
        revert(string.concat("no price fixture ", name));
    }
}
