// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {Vault} from "../../src/vault/Vault.sol";
import {LocalPyth} from "../../src/mocks/LocalPyth.sol";

/// @notice Posts and Pyth price updates for the vault's tests
/// @dev Prices are written as decimal strings, such as "2000.5", or as numbers with 18 decimals. Each becomes a Pyth
/// price with exponent -8 when it fits, else with the smallest exponent that holds it exactly. An update's
/// prevPublishTime is 0 unless a test sets it, so any P0 counts as the first price after its post; the Gate 1 tests set
/// it to check that rule.
abstract contract PythTestKit is Test {
    uint256 internal constant TWITTER_EPOCH_MS = 1288834974657;
    // 2026-10-30T12:00:00Z
    uint256 internal constant START = 1793361600;

    bytes32 internal constant ETH = keccak256("ETH");
    bytes32 internal constant OIL = keccak256("OIL");
    // Pyth's feed IDs for ETH/USD, BTC/USD and constant 1-month WTI
    bytes32 internal constant ETH_FEED = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 internal constant BTC_FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant OIL_FEED = 0xf2464139c45f26097e0173b03207c4a490dbd8bf1b72dfbf064eeb832c7c2933;
    // Account IDs: keccak256 of the lower-case handle
    bytes32 internal constant ACCOUNT = keccak256("realdonaldtrump");
    bytes32 internal constant OTHER_ACCOUNT = keccak256("elonmusk");

    uint64 internal constant NO_PREV = 0;

    struct Post {
        bytes32 account;
        uint256 tweetId;
    }

    LocalPyth internal pyth;
    Vault internal vault;

    function deployPyth() internal {
        pyth = new LocalPyth(0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Posts
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A snowflake tweet ID whose time bits say `time`
    function tweetIdAt(uint256 time) internal pure returns (uint256) {
        return ((time * 1000 - TWITTER_EPOCH_MS) << 22) | 4321;
    }

    /// @dev A post of ACCOUNT created at `createdAt`
    function signedTweet(uint256 createdAt) internal pure returns (Post memory) {
        return Post(ACCOUNT, tweetIdAt(createdAt));
    }

    function postOf(bytes32 account, uint256 tweetId) internal pure returns (Post memory) {
        return Post(account, tweetId);
    }

    /// @dev Opens a trigger with a post. Call it inside a prank of the agent.
    function openTriggerWith(address user_, bytes32 assetId, Post memory post, bytes[] memory p0)
        internal
        returns (uint256)
    {
        return vault.openTrigger(user_, assetId, post.account, post.tweetId, p0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Prices
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev An ETH price published now
    function signedPrice(string memory price) internal view returns (bytes[] memory) {
        return signedPriceOf(ETH_FEED, price, block.timestamp);
    }

    /// @dev An ETH price published at `publishTime`
    function signedPriceAt(string memory price, uint256 publishTime) internal pure returns (bytes[] memory) {
        return signedPriceOf(ETH_FEED, price, publishTime);
    }

    function signedPriceOf(bytes32 feed, string memory price, uint256 publishTime)
        internal
        pure
        returns (bytes[] memory)
    {
        return priceUpdate18(feed, parseDecimal(price), publishTime, NO_PREV);
    }

    /// @dev An ETH price with 18 decimals, published at `publishTime`
    function signedEthPrice(uint256 price18, uint256 publishTime) internal pure returns (bytes[] memory) {
        return priceUpdate18(ETH_FEED, price18, publishTime, NO_PREV);
    }

    function priceUpdate18(bytes32 feed, uint256 price18, uint256 publishTime, uint64 prevPublishTime)
        internal
        pure
        returns (bytes[] memory)
    {
        (int64 price, int32 expo) = toPyth(price18);
        return pythUpdate(feed, price, 0, expo, publishTime, prevPublishTime);
    }

    /// @dev One Pyth price update, as LocalPyth reads it
    function pythUpdate(bytes32 feed, int64 price, uint64 conf, int32 expo, uint256 publishTime, uint64 prevPublishTime)
        internal
        pure
        returns (bytes[] memory update)
    {
        PythStructs.PriceFeed memory priceFeed;
        priceFeed.id = feed;
        priceFeed.price = PythStructs.Price(price, conf, expo, publishTime);
        priceFeed.emaPrice = PythStructs.Price(price, conf, expo, publishTime);
        update = new bytes[](1);
        update[0] = abi.encode(priceFeed, prevPublishTime);
    }

    /// @dev Joins updates, as Hermes does for several feeds
    function joined(bytes[] memory first, bytes[] memory second) internal pure returns (bytes[] memory update) {
        update = new bytes[](first.length + second.length);
        for (uint256 i; i < first.length; i++) {
            update[i] = first[i];
        }
        for (uint256 i; i < second.length; i++) {
            update[first.length + i] = second[i];
        }
    }

    /// @dev An update that Pyth refuses, as it refuses one whose bytes changed after signing
    function edited(bytes[] memory update) internal pure returns (bytes[] memory) {
        bytes memory data = update[0];
        assembly ("memory-safe") {
            mstore(data, sub(mload(data), 1))
        }
        return update;
    }

    /// @dev `price18` rounded down to the nearest price that Pyth can write: a 64-bit mantissa holds about 19 digits, so
    /// a price above 9.2 USD loses its last digits of wei
    function pythPrice(uint256 price18) internal pure returns (uint256) {
        uint256 maxPrice = uint256(uint64(type(int64).max));
        uint256 unit = 1;
        while (price18 / unit > maxPrice) unit *= 10;
        return price18 / unit * unit;
    }

    /// @dev "2000.5" -> 2000.5e18
    function parseDecimal(string memory text) internal pure returns (uint256) {
        bytes memory raw = bytes(text);
        uint256 whole;
        uint256 fraction;
        uint256 digits;
        bool afterPoint;
        for (uint256 i; i < raw.length; i++) {
            bytes1 c = raw[i];
            if (c == ".") {
                afterPoint = true;
                continue;
            }
            require(c >= "0" && c <= "9", "not a decimal");
            uint256 digit = uint8(c) - 48;
            if (afterPoint) {
                require(digits < 18, "more than 18 decimals");
                fraction = fraction * 10 + digit;
                digits++;
            } else {
                whole = whole * 10 + digit;
            }
        }
        return whole * 1e18 + fraction * 10 ** (18 - digits);
    }

    /// @dev The Pyth price and exponent that hold `price18` exactly: exponent -8 when it fits, else the one with the
    /// fewest digits, which is positive for prices above 9.2e18 USD
    function toPyth(uint256 price18) internal pure returns (int64 price, int32 expo) {
        uint256 maxPrice = uint256(uint64(type(int64).max));
        if (price18 % 1e10 == 0 && price18 / 1e10 <= maxPrice) {
            // forge-lint: disable-next-line(unsafe-typecast)
            return (int64(uint64(price18 / 1e10)), -8);
        }
        for (uint256 k = 40;; k--) {
            uint256 unit = 10 ** k;
            if (price18 % unit == 0 && price18 / unit <= maxPrice && price18 >= unit) {
                // forge-lint: disable-next-line(unsafe-typecast)
                return (int64(uint64(price18 / unit)), int32(int256(k)) - 18);
            }
            if (k == 0) break;
        }
        if (price18 == 0) return (0, -8);
        revert("price does not fit a Pyth price");
    }
}
