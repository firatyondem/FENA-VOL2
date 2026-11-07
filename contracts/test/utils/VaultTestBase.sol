// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {Vault} from "../../src/vault/Vault.sol";
import {MockDEXStub} from "./MockDEXStub.sol";
import {PythTestKit} from "./PythTestKit.sol";
import {TestToken} from "./TestToken.sol";

/// @notice Deploys a vault with one asset (ETH) and one watched account on a test Pyth
abstract contract VaultTestBase is PythTestKit {
    TestToken internal usdc;
    TestToken internal teth;
    TestToken internal toil;
    MockDEXStub internal dex;

    address internal user = makeAddr("user");
    address internal agent = makeAddr("agent");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(START);
        deployPyth();

        usdc = new TestToken("Mock USDC", "mUSDC", 6);
        teth = new TestToken("Test ETH", "tETH", 18);
        toil = new TestToken("Test Oil", "tOIL", 18);
        dex = new MockDEXStub(address(usdc));
        vault = new Vault(address(this), address(dex), address(pyth));

        vault.setAssetProfile(ETH, ethProfile());
        vault.setWatchableAccount(ACCOUNT, true);

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

    /// @dev A post of ACCOUNT with `tweetId`
    function signedTweetWithId(uint256 tweetId) internal pure returns (Post memory) {
        return Post(ACCOUNT, tweetId);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Flow
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A post at the current time and P0 one minute later, opened by the agent
    function openEthTrigger(string memory p0) internal returns (uint256 triggerId) {
        uint256 postedAt = block.timestamp;
        vm.warp(postedAt + 1 minutes);
        Post memory tweet = signedTweet(postedAt);
        bytes[] memory price = signedPrice(p0);
        vm.prank(agent);
        triggerId = openTriggerWith(user, ETH, tweet, price);
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
