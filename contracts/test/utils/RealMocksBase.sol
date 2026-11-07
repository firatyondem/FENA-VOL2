// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {Vault} from "../../src/vault/Vault.sol";
import {PythTestKit} from "./PythTestKit.sol";

/// @notice Deploys the vault on Person B's real MockDEX, MockUSDC and MockAssetToken, with two assets (ETH, OIL) and
/// two watched accounts, on a local Pyth whose updates are unsigned
/// @dev Same asset ids as script/Deploy.s.sol: keccak256 of the asset's key. One user with an ETH-only rule is set up;
/// everything else is left to the suite.
abstract contract RealMocksBase is PythTestKit {
    MockUSDC internal usdc;
    MockDEX internal dex;
    MockAssetToken internal teth;
    MockAssetToken internal toil;

    address internal user = makeAddr("user");
    address internal agent = makeAddr("agent");
    address internal user2 = makeAddr("user2");
    address internal agent2 = makeAddr("agent2");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(START);
        deployPyth();

        usdc = new MockUSDC();
        dex = new MockDEX(usdc, address(this));
        teth = new MockAssetToken("Test Ether", "tETH", 18, address(dex));
        toil = new MockAssetToken("Test Crude Oil", "tOIL", 18, address(dex));
        dex.listAsset(teth);
        dex.listAsset(toil);
        vault = new Vault(address(this), address(dex), address(pyth));

        vault.setAssetProfile(ETH, ethProfile());
        vault.setAssetProfile(OIL, oilProfile());
        vault.setWatchableAccount(ACCOUNT, true);
        vault.setWatchableAccount(OTHER_ACCOUNT, true);

        fund(user, 1_000e6);
        vm.prank(user);
        setEthRule(ethRule());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Profiles and rules
    // ---------------------------------------------------------------------------------------------------------------

    // ETH/BTC row of the asset profiles: +3% threshold, 12% spike cap, 30 min -> 4 h
    function ethProfile() internal view returns (IVault.AssetProfile memory) {
        return IVault.AssetProfile({
            token: address(teth),
            priceId: ETH_FEED,
            minThresholdBps: 300,
            maxSpikeCapBps: 1200,
            minWait: 30 minutes,
            maxWindow: 4 hours,
            maxPriceAge: 5 minutes,
            maxConfBps: 200,
            maxStopLossBps: 2000
        });
    }

    // Crude oil row of the asset profiles: +1.5% threshold, 5% spike cap, 1 h -> 6 h
    function oilProfile() internal view returns (IVault.AssetProfile memory) {
        return IVault.AssetProfile({
            token: address(toil),
            priceId: OIL_FEED,
            minThresholdBps: 150,
            maxSpikeCapBps: 500,
            minWait: 1 hours,
            maxWindow: 6 hours,
            maxPriceAge: 5 minutes,
            maxConfBps: 200,
            maxStopLossBps: 2000
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
            stagnationDelay: 24 hours,
            stopLossBps: 500
        });
    }

    function oilRule() internal pure returns (IVault.AssetRule memory) {
        return IVault.AssetRule({
            thresholdBps: 150,
            spikeCapBps: 500,
            minWait: 1 hours,
            maxWindow: 6 hours,
            cooldown: 24 hours,
            budgetShareBps: 5_000,
            takeProfitBps: 800,
            stagnationBandBps: 100,
            stagnationDelay: 24 hours,
            stopLossBps: 500
        });
    }

    /// @dev 50 USDC per buy, at most 50 per trade and 200 per day
    function rule() internal view returns (IVault.Rule memory) {
        return ruleFor(agent);
    }

    function ruleFor(address agent_) internal pure returns (IVault.Rule memory) {
        return IVault.Rule({agent: agent_, buyAmount: 50e6, maxPerTrade: 50e6, dailyLimit: 200e6});
    }

    /// @dev Sets a rule with ETH as the only asset and ACCOUNT as the only watched account. Call it as the user.
    function setEthRule(IVault.AssetRule memory assetRule) internal {
        vault.setRule(rule(), one(ETH), oneRule(assetRule), topics(1), watched());
    }

    function one(bytes32 assetId) internal pure returns (bytes32[] memory assetIds) {
        assetIds = new bytes32[](1);
        assetIds[0] = assetId;
    }

    function two(bytes32 first, bytes32 second) internal pure returns (bytes32[] memory assetIds) {
        assetIds = new bytes32[](2);
        assetIds[0] = first;
        assetIds[1] = second;
    }

    function oneRule(IVault.AssetRule memory assetRule) internal pure returns (IVault.AssetRule[] memory rules) {
        rules = new IVault.AssetRule[](1);
        rules[0] = assetRule;
    }

    function twoRules(IVault.AssetRule memory first, IVault.AssetRule memory second)
        internal
        pure
        returns (IVault.AssetRule[] memory rules)
    {
        rules = new IVault.AssetRule[](2);
        rules[0] = first;
        rules[1] = second;
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

    /// @dev Mints mock USDC to `who` and deposits it into the vault
    function fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Posts
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A post of `account` with `tweetId`
    function signedTweetWithId(bytes32 account, uint256 tweetId) internal pure returns (Post memory) {
        return Post(account, tweetId);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Flow
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A post at the current time and P0 = `p0` on `feed` one minute later, opened by `agent_` for `user_`
    function openTriggerFor(address user_, address agent_, bytes32 assetId, bytes32 feed, string memory p0)
        internal
        returns (uint256 triggerId)
    {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory price = signedPriceOf(feed, p0, block.timestamp);
        vm.prank(agent_);
        triggerId = openTriggerWith(user_, assetId, tweet, price);
    }

    /// @dev A post at the current time and P0 one minute later, opened by the agent
    function openEthTrigger(string memory p0) internal returns (uint256 triggerId) {
        return openTriggerFor(user, agent, ETH, ETH_FEED, p0);
    }

    /// @dev Opens a trigger at P0 = 2000 and confirms it 31 minutes later at P1 = 2070 (+3.5%)
    function buyEth() internal returns (uint256 positionId) {
        uint256 triggerId = openEthTrigger("2000");
        vm.warp(block.timestamp + 31 minutes);
        bytes[] memory p1 = signedPrice("2070");
        vm.prank(keeper);
        positionId = vault.confirmTrigger(triggerId, p1);
    }
}
