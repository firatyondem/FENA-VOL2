// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../../src/interfaces/IVault.sol";
import {IntegrationBase} from "./IntegrationBase.sol";

/// @notice Runs the flows on Person B's signed synthetic fixtures (shared/fixtures/synthetic/): the real request
/// hashes for posts and prices, signed by the manifest's fixture Airnode
/// @dev The profiles are built from shared/asset-profiles.json the way script/Deploy.s.sol builds them with
/// DEMO_WAITS=true and FIXTURE_AIRNODES=true. The rules are the manifest's demo rules. No fixture exists for a price
/// after the buy, so sell prices are signed with the manifest's public fixture key, the same signer as the fixtures.
abstract contract FixtureFlowBase is IntegrationBase {
    string internal constant SYNTHETIC = "../shared/fixtures/synthetic/";
    string internal constant MANIFEST = "../shared/fixtures/synthetic/manifest.json";
    string internal constant PROFILES = "../shared/asset-profiles.json";

    // Time anchors of the fixtures (manifest.times and the fixture files)
    uint256 internal constant TWEET_CREATED_AT = 1793380800;
    uint256 internal constant TWEET_SIGNED_AT = 1793380860;
    // eth-p0 and oil-p0: the source took P0 two minutes after the post, the Airnode signed it a second later
    uint256 internal constant T0 = 1793380920;
    uint256 internal constant P0_SIGNED_AT = 1793380921;
    // eth-p1-early: one minute after P0
    uint256 internal constant T1_EARLY = 1793380980;
    uint256 internal constant P1_EARLY_SIGNED_AT = 1793380981;
    // eth-p1-rise, -flat, -spike and oil-p1-rise: five minutes after P0
    uint256 internal constant T1 = 1793381220;
    uint256 internal constant P1_SIGNED_AT = 1793381221;
    // eth-p1-late: fifteen minutes after P0
    uint256 internal constant T1_LATE = 1793381820;
    uint256 internal constant P1_LATE_SIGNED_AT = 1793381821;

    // The tweet IDs of tweet-trump-venezuela and tweet-musk-doge; both say 2026-10-30T17:20:00Z in their time bits
    uint256 internal constant TRUMP_TWEET_ID = 2116218573419446273;
    uint256 internal constant MUSK_TWEET_ID = 2116218573419446274;

    address internal fixtureAirnode;
    uint256 internal fixtureAirnodeKey;

    bytes32 internal trumpAccount;
    bytes32 internal muskAccount;
    bytes32 internal ethRequest;
    bytes32 internal btcRequest;
    bytes32 internal oilRequest;

    address internal alice = makeAddr("alice");
    address internal aliceAgent = makeAddr("alice agent");
    address internal bob = makeAddr("bob");
    address internal bobAgent = makeAddr("bob agent");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual override {
        super.setUp();
        string memory manifest = vm.readFile(MANIFEST);
        fixtureAirnode = vm.parseJsonAddress(manifest, ".fixtureAirnode.address");
        fixtureAirnodeKey = uint256(vm.parseJsonBytes32(manifest, ".fixtureAirnode.privateKey"));
        assertEq(vm.addr(fixtureAirnodeKey), fixtureAirnode, "manifest key does not match its address");

        trumpAccount = vm.parseJsonBytes32(manifest, ".requests['tweet:realDonaldTrump'].requestHash");
        muskAccount = vm.parseJsonBytes32(manifest, ".requests['tweet:elonmusk'].requestHash");
        ethRequest = vm.parseJsonBytes32(manifest, ".requests['price:ETH'].requestHash");
        btcRequest = vm.parseJsonBytes32(manifest, ".requests['price:BTC'].requestHash");
        oilRequest = vm.parseJsonBytes32(manifest, ".requests['price:OIL'].requestHash");

        vault.setAssetProfile(ETH, fixtureProfile("ETH", address(teth), ethRequest));
        vault.setAssetProfile(OIL, fixtureProfile("OIL", address(toil), oilRequest));
        vault.setAssetProfile(BTC, fixtureProfile("BTC", address(tbtc), btcRequest));
        vault.setWatchableAccount(trumpAccount, fixtureAirnode);
        vault.setWatchableAccount(muskAccount, fixtureAirnode);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Profiles and rules
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The asset's row of shared/asset-profiles.json with the demo's minimum wait, signed by the fixture Airnode
    function fixtureProfile(string memory key, address token, bytes32 requestHash)
        internal
        view
        returns (IVault.AssetProfile memory profile)
    {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory profiles = vm.readFile(PROFILES);
        string memory asset = string.concat(".assets.", key);
        profile.token = token;
        profile.airnode = fixtureAirnode;
        profile.priceRequestHash = requestHash;
        profile.minThresholdBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".trendThresholdBps")));
        profile.maxSpikeCapBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".spikeCapBps")));
        profile.minWait = uint32(vm.parseJsonUint(profiles, ".demoOverrides.minWaitSec"));
        profile.maxWindow = uint32(vm.parseJsonUint(profiles, string.concat(asset, ".maxWindowSec")));
        profile.maxPriceAge = uint32(vm.parseJsonUint(profiles, ".maxPriceAgeSec"));
        profile.updatedAtInMs =
            keccak256(bytes(vm.parseJsonString(profiles, string.concat(asset, ".price.timeUnit")))) == keccak256("ms");
    }

    /// @dev 50 USDC per buy, at most 50 per trade and 250 per day
    function demoRule(address agent_) internal pure returns (IVault.Rule memory) {
        return IVault.Rule({agent: agent_, buyAmount: 50e6, maxPerTrade: 50e6, dailyLimit: 250e6});
    }

    /// @dev Priority order of the demo rule: oil first, then ETH, then BTC
    function demoAssets() internal pure returns (bytes32[] memory assetIds) {
        assetIds = new bytes32[](3);
        assetIds[0] = OIL;
        assetIds[1] = ETH;
        assetIds[2] = BTC;
    }

    /// @dev The manifest's demo rules (2 min -> 10 min), the demo cooldown and stagnation delay, the default take-profit
    /// and stagnation band, and a 50 / 30 / 20 budget split of the 250 USDC daily limit (125 / 75 / 50)
    function demoAssetRules() internal pure returns (IVault.AssetRule[] memory rules) {
        rules = new IVault.AssetRule[](3);
        rules[0] = demoAssetRule(150, 500, 5_000);
        rules[1] = demoAssetRule(300, 1200, 3_000);
        rules[2] = demoAssetRule(300, 1200, 2_000);
    }

    function demoAssetRule(uint16 thresholdBps, uint16 spikeCapBps, uint16 budgetShareBps)
        internal
        pure
        returns (IVault.AssetRule memory)
    {
        return IVault.AssetRule({
            thresholdBps: thresholdBps,
            spikeCapBps: spikeCapBps,
            minWait: 2 minutes,
            maxWindow: 10 minutes,
            cooldown: 1 minutes,
            budgetShareBps: budgetShareBps,
            takeProfitBps: 800,
            stagnationBandBps: 100,
            stagnationDelay: 10 minutes
        });
    }

    function demoTopics() internal pure returns (string[] memory assetTopics) {
        assetTopics = new string[](3);
        assetTopics[0] = "Venezuela,Iran,OPEC,Strait of Hormuz";
        assetTopics[1] = "crypto reserve,SEC,Fed,Ethereum";
        assetTopics[2] = "Bitcoin,strategic bitcoin reserve";
    }

    function demoAccounts() internal view returns (bytes32[] memory accounts) {
        accounts = new bytes32[](2);
        accounts[0] = trumpAccount;
        accounts[1] = muskAccount;
    }

    /// @dev Deposits `amount` for `who` and sets the demo rule with `agent_`, checking the RuleSet event and what the
    /// vault stored
    function depositAndSetDemoRule(address who, address agent_, uint256 amount) internal {
        deposit(who, amount);

        bytes32[] memory assetIds = demoAssets();
        IVault.AssetRule[] memory assetRules = demoAssetRules();
        vm.expectEmit(address(vault));
        emit IVault.RuleSet(who, demoRule(agent_), assetIds, assetRules, demoTopics(), demoAccounts());
        vm.prank(who);
        vault.setRule(demoRule(agent_), assetIds, assetRules, demoTopics(), demoAccounts());

        (IVault.Rule memory stored, bytes32[] memory storedIds, bytes32[] memory storedAccounts) = vault.getRule(who);
        assertEq(stored.agent, agent_);
        assertEq(stored.dailyLimit, 250e6);
        assertEq(storedIds.length, 3);
        for (uint256 i; i < 3; i++) {
            assertEq(storedIds[i], assetIds[i], "priority order");
            (bool isAllowed, IVault.AssetRule memory assetRule) = vault.getAssetRule(who, assetIds[i]);
            assertTrue(isAllowed);
            assertEq(assetRule.budgetShareBps, assetRules[i].budgetShareBps);
        }
        assertEq(storedAccounts.length, 2);
        assertEq(storedAccounts[0], trumpAccount);
        assertEq(storedAccounts[1], muskAccount);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Signed responses
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A synthetic fixture, such as "eth-p0", with `data` as its exact signed bytes
    function fixture(string memory name) internal view returns (IVault.SignedResponse memory) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(string.concat(SYNTHETIC, name, ".json"));
        return IVault.SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }

    /// @dev A price for `requestHash` that the source took and the fixture Airnode signed now
    function fixtureSignedPrice(bytes32 requestHash, string memory price)
        internal
        view
        returns (IVault.SignedResponse memory)
    {
        return sign(fixtureAirnodeKey, requestHash, block.timestamp, priceData(price, block.timestamp));
    }

    /// @dev The agent opens a trigger with a fixture post and a fixture P0
    function openWithFixtures(
        address user_,
        address agent_,
        bytes32 assetId,
        string memory tweetName,
        string memory p0Name
    ) internal returns (uint256 triggerId) {
        IVault.SignedResponse memory tweet = fixture(tweetName);
        IVault.SignedResponse memory p0 = fixture(p0Name);
        vm.prank(agent_);
        triggerId = vault.openTrigger(user_, assetId, tweet, p0);
    }
}
