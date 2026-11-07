// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {SyntheticFixtures} from "../utils/SyntheticFixtures.sol";
import {BehaviourBase} from "./BehaviourBase.sol";

/// @notice Behaviour tests on the synthetic posts and prices, with the demo's limits: threshold and spike cap of the
/// asset profile, a wait of 2 minutes and a window of 10
abstract contract FixtureBase is BehaviourBase, SyntheticFixtures {
    // The agent opens the trigger 70 s after P0 and confirms 5 s after P1.
    uint256 internal constant OPEN_AT = 1793380990;
    uint256 internal constant CONFIRM_AT = 1793381225;

    function setUp() public virtual override {
        super.setUp();
        vault.setAssetProfile(ETH, syntheticProfile(address(teth), ETH_FEED, 300, 1200));
        vault.setAssetProfile(OIL, syntheticProfile(address(toil), OIL_FEED, 150, 500));
        setSyntheticRule(user, agent, accountList(trumpAccount));
        vm.warp(OPEN_AT);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Profiles and rules
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The demo's limits: 2 minutes to 10, prices at most 5 minutes old
    function syntheticProfile(address token, bytes32 feed, uint16 thresholdBps, uint16 spikeCapBps)
        internal
        pure
        returns (IVault.AssetProfile memory profile)
    {
        profile.token = token;
        profile.priceId = feed;
        profile.minThresholdBps = thresholdBps;
        profile.maxSpikeCapBps = spikeCapBps;
        profile.minWait = 2 minutes;
        profile.maxWindow = 10 minutes;
        profile.maxPriceAge = 5 minutes;
        profile.maxConfBps = 200;
        profile.maxStopLossBps = 2000;
    }

    /// @dev The ETH profile's own limits as the rule, without a cooldown, so two buys in a row meet only the check
    /// under test. Take-profit +8%, stop-loss -5%, stagnation exit within 1% after 10 minutes.
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
            stagnationDelay: 10 minutes,
            stopLossBps: 500
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

    /// @dev An ETH price published at `publishTime`, for a case that no fixture covers
    function fixtureKeyPrice(string memory price, uint256 publishTime) internal pure returns (bytes[] memory) {
        return signedPriceAt(price, publishTime);
    }

    /// @dev Opens a trigger as `agent_` for `who`
    function openWith(address who, address agent_, bytes32 assetId, Post memory tweet, bytes[] memory p0)
        internal
        returns (uint256 triggerId)
    {
        vm.prank(agent_);
        triggerId = openTriggerWith(who, assetId, tweet, p0);
    }
}
