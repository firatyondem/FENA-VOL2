// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {BehaviourBase} from "./BehaviourBase.sol";

/// @notice Runs the vault on Person B's signed synthetic fixtures in shared/fixtures/synthetic/: the real request hashes
/// of the posts and prices, signed by the manifest's public fixture Airnode
/// @dev ETH and OIL get the manifest's demo limits (2 min -> 10 min) with the fixture Airnode as signer. The user's rule
/// allows ETH only and watches only realDonaldTrump, so OIL and elonmusk are registered but not part of the rule. The
/// block time starts at OPEN_AT, where every post and P0 fixture is fresh.
abstract contract FixtureBase is BehaviourBase {
    string internal constant SYNTHETIC = "../shared/fixtures/synthetic/";
    string internal constant MANIFEST = "../shared/fixtures/synthetic/manifest.json";
    string internal constant NODARY_ETH_USD = "../shared/fixtures/nodary-eth-usd.json";
    string internal constant NODARY_BTC_USD = "../shared/fixtures/nodary-btc-usd.json";

    // Time anchors of the fixtures (manifest.times and the files themselves)
    uint256 internal constant TWEET_CREATED_AT = 1793380800;
    uint256 internal constant TWEET_SIGNED_AT = 1793380860;
    // eth-p0 and oil-p0: the source took P0 two minutes after the post
    uint256 internal constant T0 = 1793380920;
    // eth-p1-early: one minute after P0
    uint256 internal constant T1_EARLY = 1793380980;
    // eth-p1-rise, -flat, -spike and the tamper fixtures: five minutes after P0, signed a second later
    uint256 internal constant T1 = 1793381220;
    uint256 internal constant P1_SIGNED_AT = 1793381221;
    // tamper-stale: a genuine signature from a day before
    uint256 internal constant STALE_SIGNED_AT = 1793294520;
    // tweet-trump-old: a post from two days before, signed fresh
    uint256 internal constant OLD_TWEET_CREATED_AT = 1793208000;

    // Within five minutes of the posts' signature and of eth-p1-early's, so every post and P0 candidate is fresh
    uint256 internal constant OPEN_AT = 1793380990;
    // Four seconds after the P1 fixtures were signed
    uint256 internal constant CONFIRM_AT = 1793381225;

    uint256 internal constant TRUMP_TWEET_ID = 2116218573419446273;
    uint256 internal constant MUSK_TWEET_ID = 2116218573419446274;
    uint256 internal constant OLD_TWEET_ID = 2115493797688246275;

    address internal fixtureAirnode;
    uint256 internal fixtureAirnodeKey;
    // Signer of tamper-wrong-signer
    address internal attacker;

    bytes32 internal trumpAccount;
    bytes32 internal muskAccount;
    bytes32 internal ethRequest;
    bytes32 internal btcRequest;
    bytes32 internal oilRequest;

    function setUp() public virtual override {
        super.setUp();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory manifest = vm.readFile(MANIFEST);
        fixtureAirnode = vm.parseJsonAddress(manifest, ".fixtureAirnode.address");
        fixtureAirnodeKey = uint256(vm.parseJsonBytes32(manifest, ".fixtureAirnode.privateKey"));
        assertEq(vm.addr(fixtureAirnodeKey), fixtureAirnode, "manifest key does not match its address");
        attacker = vm.parseJsonAddress(manifest, ".attacker.address");

        trumpAccount = vm.parseJsonBytes32(manifest, ".requests['tweet:realDonaldTrump'].requestHash");
        muskAccount = vm.parseJsonBytes32(manifest, ".requests['tweet:elonmusk'].requestHash");
        ethRequest = vm.parseJsonBytes32(manifest, ".requests['price:ETH'].requestHash");
        btcRequest = vm.parseJsonBytes32(manifest, ".requests['price:BTC'].requestHash");
        oilRequest = vm.parseJsonBytes32(manifest, ".requests['price:OIL'].requestHash");

        vault.setAssetProfile(ETH, syntheticProfile("ETH", address(teth), ethRequest));
        vault.setAssetProfile(OIL, syntheticProfile("OIL", address(toil), oilRequest));
        vault.setWatchableAccount(trumpAccount, fixtureAirnode);
        vault.setWatchableAccount(muskAccount, fixtureAirnode);

        setSyntheticRule(user, agent, accountList(trumpAccount));
        vm.warp(OPEN_AT);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Profiles and rules
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The manifest's demo limits for `key` ("ETH" or "OIL"), with the fixture Airnode as the price signer
    function syntheticProfile(string memory key, address token, bytes32 requestHash)
        internal
        view
        returns (IVault.AssetProfile memory profile)
    {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory manifest = vm.readFile(MANIFEST);
        string memory limits = string.concat(".rules.", key);
        profile.token = token;
        profile.airnode = fixtureAirnode;
        profile.priceRequestHash = requestHash;
        profile.minThresholdBps = uint16(vm.parseJsonUint(manifest, string.concat(limits, ".trendThresholdBps")));
        profile.maxSpikeCapBps = uint16(vm.parseJsonUint(manifest, string.concat(limits, ".spikeCapBps")));
        profile.minWait = uint32(vm.parseJsonUint(manifest, string.concat(limits, ".minWaitSec")));
        profile.maxWindow = uint32(vm.parseJsonUint(manifest, string.concat(limits, ".maxWindowSec")));
        profile.maxPriceAge = 5 minutes;
        profile.updatedAtInMs = true;
    }

    /// @dev The ETH profile's own limits as the rule, without a cooldown, so two buys in a row meet only the check
    /// under test. Take-profit +8%, stagnation exit within 1% after 10 minutes.
    function syntheticEthRule() internal view returns (IVault.AssetRule memory) {
        IVault.AssetProfile memory profile = vault.getAssetProfile(ETH);
        return IVault.AssetRule({
            thresholdBps: profile.minThresholdBps,
            spikeCapBps: profile.maxSpikeCapBps,
            minWait: profile.minWait,
            maxWindow: profile.maxWindow,
            cooldown: 0,
            budgetShareBps: 10_000,
            takeProfitBps: 800,
            stagnationBandBps: 100,
            stagnationDelay: 10 minutes
        });
    }

    /// @dev Sets an ETH-only rule for `who` with `agent_`, watching `accounts`
    function setSyntheticRule(address who, address agent_, bytes32[] memory accounts) internal {
        // Built before the prank: syntheticEthRule calls the vault, which would use up the prank.
        IVault.AssetRule[] memory assetRules = oneRule(syntheticEthRule());
        vm.prank(who);
        vault.setRule(ruleFor(agent_), one(ETH), assetRules, topics(1), accounts);
    }

    function accountList(bytes32 account) internal pure returns (bytes32[] memory accounts) {
        accounts = new bytes32[](1);
        accounts[0] = account;
    }

    function accountList(bytes32 first, bytes32 second) internal pure returns (bytes32[] memory accounts) {
        accounts = new bytes32[](2);
        accounts[0] = first;
        accounts[1] = second;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Signed responses
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A synthetic fixture, such as "eth-p0", with `data` as its exact signed bytes
    function fixture(string memory name) internal view returns (IVault.SignedResponse memory) {
        return readFixture(string.concat(SYNTHETIC, name, ".json"));
    }

    /// @dev The "airnode" field that Person B's fixture file names as the signer
    function fixtureSigner(string memory name) internal view returns (address) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        return vm.parseJsonAddress(vm.readFile(string.concat(SYNTHETIC, name, ".json")), ".airnode");
    }

    /// @dev An ETH price that the source took at `updatedAt` and the fixture Airnode signed now, for a case that no
    /// fixture covers
    function fixtureKeyPrice(string memory price, uint256 updatedAt)
        internal
        view
        returns (IVault.SignedResponse memory)
    {
        return sign(fixtureAirnodeKey, ethRequest, block.timestamp, priceData(price, updatedAt));
    }

    /// @dev Opens a trigger as `agent_` for `who`
    function openWith(
        address who,
        address agent_,
        bytes32 assetId,
        IVault.SignedResponse memory tweet,
        IVault.SignedResponse memory p0
    ) internal returns (uint256 triggerId) {
        vm.prank(agent_);
        triggerId = vault.openTrigger(who, assetId, tweet, p0);
    }
}
