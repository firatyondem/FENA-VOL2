// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../../src/interfaces/IVault.sol";
import {SyntheticFixtures} from "../../utils/SyntheticFixtures.sol";
import {IntegrationBase} from "./IntegrationBase.sol";

/// @notice Runs the flows on the synthetic posts and prices of the hackathon's fixtures, as Pyth updates
/// @dev The profiles are built from shared/asset-profiles.json the way script/Deploy.s.sol builds them with
/// DEMO_WAITS=true and FIXTURE_AIRNODES=true. The rules are the manifest's demo rules. No fixture exists for a price
/// after the buy, so sell prices are signed with the manifest's public fixture key, the same signer as the fixtures.
abstract contract FixtureFlowBase is IntegrationBase, SyntheticFixtures {
    string internal constant PROFILES = "../shared/asset-profiles.json";

    // When each fixture's P0 or P1 reaches the vault: one second after Pyth published it
    uint256 internal constant P0_SIGNED_AT = T0 + 1;
    uint256 internal constant P1_EARLY_SIGNED_AT = T1_EARLY + 1;
    uint256 internal constant P1_SIGNED_AT = T1 + 1;
    uint256 internal constant P1_LATE_SIGNED_AT = T1_LATE + 1;

    address internal alice = makeAddr("alice");
    address internal aliceAgent = makeAddr("alice agent");
    address internal bob = makeAddr("bob");
    address internal bobAgent = makeAddr("bob agent");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual override {
        super.setUp();
        vault.setAssetProfile(ETH, fixtureProfile("ETH", address(teth), ETH_FEED));
        vault.setAssetProfile(OIL, fixtureProfile("OIL", address(toil), OIL_FEED));
        vault.setAssetProfile(BTC, fixtureProfile("BTC", address(tbtc), BTC_FEED));
        vault.setWatchableAccount(trumpAccount, true);
        vault.setWatchableAccount(muskAccount, true);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Profiles and rules
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The asset's row of shared/asset-profiles.json with the demo's minimum wait, with its Pyth feed
    function fixtureProfile(string memory key, address token, bytes32 feed)
        internal
        view
        returns (IVault.AssetProfile memory profile)
    {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory profiles = vm.readFile(PROFILES);
        string memory asset = string.concat(".assets.", key);
        profile.token = token;
        profile.priceId = feed;
        profile.minThresholdBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".trendThresholdBps")));
        profile.maxSpikeCapBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".spikeCapBps")));
        profile.minWait = uint32(vm.parseJsonUint(profiles, ".demoOverrides.minWaitSec"));
        profile.maxWindow = uint32(vm.parseJsonUint(profiles, string.concat(asset, ".maxWindowSec")));
        profile.maxPriceAge = uint32(vm.parseJsonUint(profiles, ".maxPriceAgeSec"));
        profile.maxConfBps = 200;
        profile.maxStopLossBps = uint16(vm.parseJsonUint(profiles, ".maxStopLossBps"));
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
            stagnationDelay: 10 minutes,
            stopLossBps: 0
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

    /// @dev A price of `feed` published now, for a case that no fixture covers
    function fixtureSignedPrice(bytes32 feed, string memory price) internal view returns (bytes[] memory) {
        return signedPriceOf(feed, price, block.timestamp);
    }

    /// @dev Opens a trigger as `agent_` for `user_` with a post fixture and a price fixture
    function openWithFixtures(
        address user_,
        address agent_,
        bytes32 assetId,
        string memory tweetName,
        string memory p0Name
    ) internal returns (uint256 triggerId) {
        Post memory tweet = fixtureTweet(tweetName);
        bytes[] memory p0 = fixture(p0Name);
        vm.prank(agent_);
        triggerId = openTriggerWith(user_, assetId, tweet, p0);
    }
}
