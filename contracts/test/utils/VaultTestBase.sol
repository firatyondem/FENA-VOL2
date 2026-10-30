// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {Vault} from "../../src/vault/Vault.sol";
import {AirnodeV2Test} from "./AirnodeV2Test.sol";
import {MockDEXStub} from "./MockDEXStub.sol";
import {TestToken} from "./TestToken.sol";

/// @notice Deploys a vault with one asset (ETH) and one watched account, and signs posts and prices with test keys
abstract contract VaultTestBase is AirnodeV2Test {
    uint256 internal constant TWITTER_EPOCH_MS = 1288834974657;
    // 2026-10-30T12:00:00Z
    uint256 internal constant START = 1793361600;

    bytes32 internal constant ETH = keccak256("ETH");
    bytes32 internal constant OIL = keccak256("OIL");
    bytes32 internal constant ETH_PRICE_REQUEST = keccak256("latestFeeds ETH/USD");
    bytes32 internal constant BTC_PRICE_REQUEST = keccak256("latestFeeds BTC/USD");
    bytes32 internal constant OIL_PRICE_REQUEST = keccak256("latestFeeds WTI/USD");
    bytes32 internal constant ACCOUNT = keccak256("userLastTweets realDonaldTrump");

    TestToken internal usdc;
    TestToken internal teth;
    TestToken internal toil;
    MockDEXStub internal dex;
    Vault internal vault;

    address internal priceAirnode;
    uint256 internal priceAirnodeKey;
    address internal tweetAirnode;
    uint256 internal tweetAirnodeKey;

    address internal user = makeAddr("user");
    address internal agent = makeAddr("agent");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(START);
        (priceAirnode, priceAirnodeKey) = makeAddrAndKey("price airnode");
        (tweetAirnode, tweetAirnodeKey) = makeAddrAndKey("tweet airnode");

        usdc = new TestToken("Mock USDC", "mUSDC", 6);
        teth = new TestToken("Test ETH", "tETH", 18);
        toil = new TestToken("Test Oil", "tOIL", 18);
        dex = new MockDEXStub(address(usdc));
        vault = new Vault(address(this), address(dex));

        vault.setAssetProfile(ETH, ethProfile());
        vault.setWatchableAccount(ACCOUNT, tweetAirnode);

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000e6);
        setEthRule(ethRule());
        vm.stopPrank();
    }

    // ETH/BTC row of the asset profiles: +3% threshold, 12% spike cap, 30 min -> 4 h
    function ethProfile() internal view returns (IVault.AssetProfile memory) {
        return IVault.AssetProfile({
            token: address(teth),
            airnode: priceAirnode,
            priceRequestHash: ETH_PRICE_REQUEST,
            minThresholdBps: 300,
            maxSpikeCapBps: 1200,
            minWait: 30 minutes,
            maxWindow: 4 hours,
            maxPriceAge: 5 minutes,
            updatedAtInMs: true
        });
    }

    function ethRule() internal pure returns (IVault.AssetRule memory) {
        return IVault.AssetRule({
            thresholdBps: 300,
            spikeCapBps: 1200,
            minWait: 30 minutes,
            maxWindow: 4 hours,
            cooldown: 24 hours,
            budgetShareBps: 10_000,
            takeProfitBps: 800,
            stagnationBandBps: 100,
            stagnationDelay: 24 hours
        });
    }

    function rule() internal view returns (IVault.Rule memory) {
        return IVault.Rule({agent: agent, buyAmount: 50e6, maxPerTrade: 50e6, dailyLimit: 200e6});
    }

    /// @dev Sets a rule with ETH as the only asset and ACCOUNT as the only watched account. Call it as the user.
    function setEthRule(IVault.AssetRule memory assetRule) internal {
        bytes32[] memory assetIds = new bytes32[](1);
        assetIds[0] = ETH;
        IVault.AssetRule[] memory assetRules = new IVault.AssetRule[](1);
        assetRules[0] = assetRule;
        vault.setRule(rule(), assetIds, assetRules, topics(1), watched());
    }

    /// @dev The same topic keywords for each of `count` assets
    function topics(uint256 count) internal pure returns (string[] memory assetTopics) {
        assetTopics = new string[](count);
        for (uint256 i; i < count; i++) {
            assetTopics[i] = "tariffs,Venezuela";
        }
    }

    function watched() internal pure returns (bytes32[] memory accounts) {
        accounts = new bytes32[](1);
        accounts[0] = ACCOUNT;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Signed responses
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A snowflake tweet ID whose time bits say `time`
    function tweetIdAt(uint256 time) internal pure returns (uint256) {
        return ((time * 1000 - TWITTER_EPOCH_MS) << 22) | 4321;
    }

    /// @dev A post of ACCOUNT, created at `createdAt` and signed now
    function signedTweet(uint256 createdAt) internal view returns (IVault.SignedResponse memory) {
        return signedTweetWithId(tweetIdAt(createdAt));
    }

    function signedTweetWithId(uint256 tweetId) internal view returns (IVault.SignedResponse memory) {
        // TwitterAPI.io writes the ID as a string.
        bytes memory data = bytes(string.concat('{"id":"', vm.toString(tweetId), '"}'));
        return sign(tweetAirnodeKey, ACCOUNT, block.timestamp, data);
    }

    /// @dev An ETH price, such as "2000.5", that the source took and the Airnode signed now
    function signedPrice(string memory price) internal view returns (IVault.SignedResponse memory) {
        return signedPriceAt(price, block.timestamp);
    }

    /// @dev An ETH price that the source took at `updatedAt` and the Airnode signed now
    function signedPriceAt(string memory price, uint256 updatedAt)
        internal
        view
        returns (IVault.SignedResponse memory)
    {
        return sign(priceAirnodeKey, ETH_PRICE_REQUEST, block.timestamp, priceData(price, updatedAt));
    }

    /// @dev Nodary's projection: the price and the time in milliseconds at which Nodary took it
    function priceData(string memory price, uint256 updatedAt) internal pure returns (bytes memory) {
        return bytes(string.concat('{"price":', price, ',"updatedAt":', vm.toString(updatedAt * 1000 + 279), "}"));
    }

    function sign(uint256 key, bytes32 requestHash, uint256 timestamp, bytes memory data)
        internal
        pure
        returns (IVault.SignedResponse memory)
    {
        return IVault.SignedResponse({
            requestHash: requestHash,
            timestamp: timestamp,
            data: data,
            signature: signResponse(key, requestHash, timestamp, data)
        });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Flow
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A post at the current time and P0 one minute later, opened by the agent
    function openEthTrigger(string memory p0) internal returns (uint256 triggerId) {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(postedAt);
        IVault.SignedResponse memory price = signedPrice(p0);
        vm.prank(agent);
        triggerId = vault.openTrigger(user, ETH, tweet, price);
    }

    /// @dev Opens a trigger at P0 = 2000 and confirms it 31 minutes later at P1 = 2070 (+3.5%)
    function buyEth() internal returns (uint256 positionId) {
        uint256 triggerId = openEthTrigger("2000");
        vm.warp(block.timestamp + 31 minutes);
        IVault.SignedResponse memory p1 = signedPrice("2070");
        vm.prank(keeper);
        positionId = vault.confirmTrigger(triggerId, p1);
    }
}
