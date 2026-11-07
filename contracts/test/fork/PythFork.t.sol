// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {Vault} from "../../src/vault/Vault.sol";

/// @notice The vault on a fork of Base Sepolia, against the real Pyth contract, with real signed updates from
/// shared/fixtures/pyth: a buy and a stop-loss on real ETH prices, and the tamper test (an edited, old, wrong-asset and
/// replayed update, and a P0 that is not the first price after the post), each refused with the vault's named error.
/// @dev Needs an archive RPC for Base Sepolia: BASE_SEPOLIA_RPC_URL, else the public publicnode endpoint. Skip it offline
/// with `forge test --no-match-path "test/fork/*"`.
contract PythForkTest is Test {
    address constant PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;
    // Just after the last fixture's transaction
    uint256 constant FORK_BLOCK = 55709600;
    uint256 constant TWITTER_EPOCH_MS = 1288834974657;

    bytes32 constant ETH = keccak256("ETH");
    bytes32 constant DOGE = keccak256("DOGE");
    bytes32 constant ETH_FEED = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant DOGE_FEED = 0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c;
    bytes32 constant ACCOUNT = keccak256("euphraty");

    // The fixtures' ETH prices and publish times. Pyth's previous price came a second earlier each time.
    uint256 constant P0_TIME = 1794057378;
    uint256 constant P0 = 2236.50466218e18;
    uint256 constant P1_TIME = 1794059218;
    uint256 constant P1 = 2244.64595033e18;
    uint256 constant LATER_TIME = 1794063774;
    uint256 constant LATER = 2242.62750143e18;

    // Pyth charges 10 wei per price in an update, and each fixture holds three: ETH, BTC and one more
    uint256 constant FEE = 30;

    Vault vault;
    MockUSDC usdc;
    MockAssetToken teth;
    address user = makeAddr("user");
    address agent = makeAddr("agent");
    address keeper = makeAddr("keeper");

    bytes[] p0;
    bytes[] p1;
    bytes[] later;

    function setUp() public {
        vm.createSelectFork(
            vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://base-sepolia-rpc.publicnode.com")), FORK_BLOCK
        );
        p0 = fixture("eth-p0");
        p1 = fixture("eth-p1");
        later = fixture("eth-later");

        usdc = new MockUSDC();
        MockDEX dex = new MockDEX(usdc, address(this));
        teth = new MockAssetToken("Test Ether", "tETH", 18, address(dex));
        dex.listAsset(teth);
        vault = new Vault(address(this), address(dex), PYTH);
        vault.setAssetProfile(ETH, profile(address(teth), ETH_FEED));
        vault.setWatchableAccount(ACCOUNT, true);

        // A rule that real ETH can meet in half an hour: +0.30% after 30 minutes, stop-loss at -0.05%
        IVault.AssetRule[] memory rules = new IVault.AssetRule[](1);
        rules[0] = IVault.AssetRule({
            thresholdBps: 30,
            spikeCapBps: 1200,
            minWait: 30 minutes,
            maxWindow: 4 hours,
            cooldown: 0,
            budgetShareBps: 10_000,
            takeProfitBps: 800,
            stagnationBandBps: 100,
            stagnationDelay: 1 days,
            stopLossBps: 5
        });
        bytes32[] memory assets = new bytes32[](1);
        assets[0] = ETH;
        bytes32[] memory accounts = new bytes32[](1);
        accounts[0] = ACCOUNT;
        string[] memory topics = new string[](1);
        topics[0] = "Ethereum";
        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000e6);
        vault.setRule(
            IVault.Rule({agent: agent, buyAmount: 50e6, maxPerTrade: 50e6, dailyLimit: 200e6}),
            assets,
            rules,
            topics,
            accounts
        );
        vm.stopPrank();
        vm.deal(agent, 1 ether);
        vm.deal(keeper, 1 ether);
        vm.deal(user, 1 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // A real run
    // ---------------------------------------------------------------------------------------------------------------

    function test_RealPrices_OpenBuyAndStopTheLoss() public {
        assertEq(vault.updateFee(p0), FEE, "Pyth's fee on Base Sepolia: 10 wei per price in the update");
        uint256 triggerId = openAt(P0_TIME);
        IVault.Trigger memory trigger = vault.getTrigger(triggerId);
        assertEq(trigger.p0, P0, "P0 is Pyth's price with 18 decimals");
        assertEq(trigger.t0, P0_TIME);

        vm.warp(P1_TIME + 10);
        uint256 keeperBefore = keeper.balance;
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger{value: 1000}(triggerId, p1);
        assertEq(keeperBefore - keeper.balance, FEE, "the keeper paid Pyth's fee and got the rest back");
        assertEq(vault.getPosition(positionId).entryPrice, P1, "bought at P1");

        // 2242.63 is 9 basis points below the entry, past the 5 basis point stop-loss: anyone may sell.
        vm.warp(LATER_TIME + 10);
        vm.prank(keeper);
        uint256 quoteOut = vault.sell{value: FEE}(positionId, IVault.SellReason.StopLoss, later);
        assertFalse(vault.getPosition(positionId).isOpen);
        assertLt(quoteOut, 50e6, "sold at a loss");
        assertGt(quoteOut, 49.9e6, "a small one");
    }

    function test_RealPrices_ManualSellWithAnyFreshUpdate() public {
        uint256 triggerId = openAt(P0_TIME);
        vm.warp(P1_TIME + 10);
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger{value: FEE}(triggerId, p1);

        vm.warp(LATER_TIME + 60);
        vm.prank(user);
        vault.sell{value: FEE}(positionId, IVault.SellReason.Manual, later);
        assertFalse(vault.getPosition(positionId).isOpen);
    }

    function test_CheckPrice_ReadsARealUpdate() public {
        vm.warp(P1_TIME + 1);
        (uint256 price, uint256 publishTime) = vault.checkPrice{value: FEE}(ETH, p1);
        assertEq(price, P1);
        assertEq(publishTime, P1_TIME);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The tamper test
    // ---------------------------------------------------------------------------------------------------------------

    function test_Tamper_AnEditedPriceIsRefused() public {
        vm.warp(P1_TIME + 1);
        bytes[] memory edited = withEthPriceEdited(p1);
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.checkPrice{value: FEE}(ETH, edited);
    }

    function test_Tamper_AnOldPriceIsRefused() public {
        vm.warp(P1_TIME + 5 minutes + 1);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, P1_TIME));
        vault.checkPrice{value: FEE}(ETH, p1);
    }

    function test_Tamper_AnUpdateOfAnotherAssetIsRefused() public {
        // DOGE's feed is not in the update, which holds ETH, BTC and one more feed.
        vault.setAssetProfile(DOGE, profile(makeAddr("tDOGE"), DOGE_FEED));
        vm.warp(P1_TIME + 1);
        vm.expectRevert(abi.encodeWithSelector(IVault.WrongPriceFeed.selector, DOGE_FEED));
        vault.checkPrice{value: FEE}(DOGE, p1);
    }

    function test_Tamper_AReplayedP0IsRefused() public {
        openAt(P0_TIME);
        // A second post in the same second: the same P0 would be the first price after it too, but it is used.
        uint256 otherPost = tweetIdAt(P0_TIME) + 1;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceAlreadyUsed.selector, ETH, P0_TIME));
        vault.openTrigger{value: FEE}(user, ETH, ACCOUNT, otherPost, p0);
    }

    function test_Tamper_AReplayedP1IsRefused() public {
        uint256 triggerId = openAt(P0_TIME);
        vm.warp(P1_TIME + 10);
        vault.confirmTrigger{value: FEE}(triggerId, p1);
        vm.expectRevert(abi.encodeWithSelector(IVault.TriggerNotOpen.selector, triggerId));
        vault.confirmTrigger{value: FEE}(triggerId, p1);
    }

    function test_Tamper_AP0ThatIsNotTheFirstAfterThePostIsRefused() public {
        // Pyth published a price at P0_TIME - 1 too, so for a post at that second P0 is the second price, not the first.
        vm.warp(P0_TIME + 60);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceNotFirstAfterPost.selector, P0_TIME - 1, P0_TIME));
        vault.openTrigger{value: FEE}(user, ETH, ACCOUNT, tweetIdAt(P0_TIME - 1), p0);
    }

    function test_Tamper_AP0TooLongAfterThePostIsRefused() public {
        uint256 postedAt = P0_TIME - 10 minutes - 1;
        vm.warp(P0_TIME + 60);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceOutsideTweetWindow.selector, postedAt, P0_TIME));
        vault.openTrigger{value: FEE}(user, ETH, ACCOUNT, tweetIdAt(postedAt), p0);
    }

    function test_Tamper_P0BroughtBackAsP1IsRefused() public {
        // P0 again as P1: still fresh five minutes later, but published at t0, so the wait is not over.
        uint256 triggerId = openAt(P0_TIME);
        vm.warp(P0_TIME + 5 minutes);
        vm.expectRevert(abi.encodeWithSelector(IVault.WaitNotOver.selector, P0_TIME + 30 minutes));
        vault.confirmTrigger{value: FEE}(triggerId, p0);
    }

    function test_Tamper_TooLowAFeeIsRefused() public {
        vm.warp(P1_TIME + 1);
        vm.expectRevert(abi.encodeWithSelector(IVault.InsufficientFee.selector, FEE - 1, FEE));
        vault.checkPrice{value: FEE - 1}(ETH, p1);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------------

    function openAt(uint256 postedAt) internal returns (uint256 triggerId) {
        vm.warp(postedAt + 60);
        vm.prank(agent);
        triggerId = vault.openTrigger{value: FEE}(user, ETH, ACCOUNT, tweetIdAt(postedAt), p0);
    }

    function profile(address token, bytes32 feed) internal pure returns (IVault.AssetProfile memory) {
        return IVault.AssetProfile({
            token: token,
            priceId: feed,
            minThresholdBps: 30,
            maxSpikeCapBps: 1200,
            minWait: 30 minutes,
            maxWindow: 4 hours,
            maxPriceAge: 5 minutes,
            maxConfBps: 100,
            maxStopLossBps: 2000
        });
    }

    function tweetIdAt(uint256 time) internal pure returns (uint256) {
        return (time * 1000 - TWITTER_EPOCH_MS) << 22;
    }

    /// @dev The `bytes[]` of a Hermes response saved in shared/fixtures/pyth
    function fixture(string memory name) internal view returns (bytes[] memory updates) {
        string memory json = vm.readFile(string.concat("../shared/fixtures/pyth/", name, ".json"));
        string[] memory data = vm.parseJsonStringArray(json, ".binary.data");
        updates = new bytes[](data.length);
        for (uint256 i; i < data.length; i++) {
            updates[i] = vm.parseBytes(string.concat("0x", data[i]));
        }
    }

    /// @dev The update with the last byte of ETH's price changed, as an attacker would raise it
    function withEthPriceEdited(bytes[] memory updates) internal pure returns (bytes[] memory edited) {
        bytes memory data = bytes.concat(updates[0]);
        for (uint256 i; i + 32 <= data.length; i++) {
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(data, 32), i))
            }
            if (word == ETH_FEED) {
                // The price is the int64 right after the feed ID.
                data[i + 32 + 7] = bytes1(uint8(data[i + 32 + 7]) ^ 0x01);
                edited = new bytes[](1);
                edited[0] = data;
                return edited;
            }
        }
        revert("no ETH price in the update");
    }
}
