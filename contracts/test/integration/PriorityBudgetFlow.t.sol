// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FixtureFlowBase} from "./utils/FixtureFlowBase.sol";

/// @notice Integration flow 5: one post matches several assets, and the agent serves them in the user's priority order
/// (oil, ETH, BTC) until each asset's slice of the daily limit runs out
/// @dev The demo rule has a daily limit of 250 USDC split 50 / 30 / 20, so oil gets 125, ETH 75 and BTC 50, and every
/// buy is 50. The contract keeps the priority order in the rule and enforces the slices, not the order of the calls: a
/// low-priority asset can never eat the day's budget of a higher one. Posts are created and prices published as the flow
/// goes, because the fixtures cover one post and one price per asset.
contract PriorityBudgetFlowTest is FixtureFlowBase {
    uint256 constant DEPOSIT = 500e6;
    uint256 constant BUY = 50e6;

    function setUp() public override {
        super.setUp();
        depositAndSetDemoRule(alice, aliceAgent, DEPOSIT);
    }

    function test_OnePostServesOilEthAndBtcInOrderUntilEachSliceRunsOut() public {
        (, bytes32[] memory priority,) = vault.getRule(alice);
        assertEq(priority.length, 3);
        assertEq(priority[0], OIL, "first priority");
        assertEq(priority[1], ETH, "second priority");
        assertEq(priority[2], BTC, "third priority");

        // Round 1: one post, one trigger per asset in priority order, and every asset buys once.
        (uint256 oil, uint256 eth, uint256 btc) = openAllFromNewPost();
        assertEq(oil, 1);
        assertEq(eth, 2);
        assertEq(btc, 3);
        assertEq(vault.getTrigger(oil).tweetId, vault.getTrigger(eth).tweetId, "one post");
        assertEq(vault.getTrigger(oil).tweetId, vault.getTrigger(btc).tweetId, "one post");
        vm.warp(block.timestamp + 5 minutes);
        assertEq(vault.getPosition(confirm(oil, OIL_FEED, "71.4")).assetId, OIL);
        assertEq(vault.getPosition(confirm(eth, ETH_FEED, "2070")).assetId, ETH);
        assertEq(vault.getPosition(confirm(btc, BTC_FEED, "103500")).assetId, BTC);
        assertEq(vault.balanceOf(alice), DEPOSIT - 3 * BUY);
        assertBooksBalance();

        // Round 2, later the same day: oil still fits in its 125, ETH has 25 left of 75, BTC has nothing left of 50.
        (oil, eth, btc) = openAllFromNewPost();
        vm.warp(block.timestamp + 5 minutes);
        confirm(oil, OIL_FEED, "71.4");
        expectRejected(eth, ETH_FEED, "2070", abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, BUY, 25e6));
        expectRejected(btc, BTC_FEED, "103500", abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, BUY, 0));

        // The two rejected triggers stay open until their window closes, then anyone expires them and nothing moves.
        uint256 balanceBefore = vault.balanceOf(alice);
        vm.warp(vault.getTrigger(eth).t0 + 10 minutes + 1);
        vault.expireTrigger(eth);
        vault.expireTrigger(btc);
        assertEq(uint256(vault.getTrigger(eth).status), uint256(IVault.TriggerStatus.Expired));
        assertEq(uint256(vault.getTrigger(btc).status), uint256(IVault.TriggerStatus.Expired));
        assertEq(vault.balanceOf(alice), balanceBefore);

        // Round 3: a third oil buy would pass 125 (it has 25 left), so it is rejected too.
        uint256 thirdOil = openOilFromNewPost();
        vm.warp(block.timestamp + 5 minutes);
        expectRejected(
            thirdOil, OIL_FEED, "71.4", abi.encodeWithSelector(IVault.DailyBudgetExceeded.selector, BUY, 25e6)
        );

        // What was spent stays inside each slice and inside the daily limit of 250.
        assertEq(vault.spentToday(alice, OIL), 2 * BUY);
        assertEq(vault.spentToday(alice, ETH), BUY);
        assertEq(vault.spentToday(alice, BTC), BUY);
        assertLe(vault.spentToday(alice, OIL) + vault.spentToday(alice, ETH) + vault.spentToday(alice, BTC), 250e6);
        assertEq(vault.balanceOf(alice), DEPOSIT - 4 * BUY);
        assertBooksBalance();

        // The next UTC day starts with fresh slices: ETH buys again and oil has spent nothing yet.
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        assertEq(vault.spentToday(alice, OIL), 0, "a new day");
        uint256 nextDayEth = openEthFromNewPost();
        vm.warp(block.timestamp + 5 minutes);
        confirm(nextDayEth, ETH_FEED, "2070");
        assertEq(vault.spentToday(alice, ETH), BUY);
        assertEq(vault.balanceOf(alice), DEPOSIT - 5 * BUY);
        assertBooksBalance();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev A post of Trump created now
    function freshTrumpPost() internal view returns (Post memory) {
        return postOf(trumpAccount, tweetIdAt(block.timestamp));
    }

    function openFrom(Post memory post, bytes32 assetId, bytes32 request, string memory p0) internal returns (uint256) {
        bytes[] memory price = fixtureSignedPrice(request, p0);
        vm.prank(aliceAgent);
        return openTriggerWith(alice, assetId, post, price);
    }

    /// @dev One post that matches oil, ETH and BTC: a minute later the agent opens a trigger for each, in priority order
    function openAllFromNewPost() internal returns (uint256 oil, uint256 eth, uint256 btc) {
        Post memory post = freshTrumpPost();
        vm.warp(block.timestamp + 1 minutes);
        oil = openFrom(post, OIL, OIL_FEED, "70.25");
        eth = openFrom(post, ETH, ETH_FEED, "2000");
        btc = openFrom(post, BTC, BTC_FEED, "100000");
    }

    function openOilFromNewPost() internal returns (uint256) {
        Post memory post = freshTrumpPost();
        vm.warp(block.timestamp + 1 minutes);
        return openFrom(post, OIL, OIL_FEED, "70.25");
    }

    function openEthFromNewPost() internal returns (uint256) {
        Post memory post = freshTrumpPost();
        vm.warp(block.timestamp + 1 minutes);
        return openFrom(post, ETH, ETH_FEED, "2000");
    }

    /// @dev Anyone confirms with a P1 published now
    function confirm(uint256 triggerId, bytes32 request, string memory p1) internal returns (uint256) {
        bytes[] memory price = fixtureSignedPrice(request, p1);
        vm.prank(keeper);
        return vault.confirmTrigger(triggerId, price);
    }

    function expectRejected(uint256 triggerId, bytes32 request, string memory p1, bytes memory err) internal {
        bytes[] memory price = fixtureSignedPrice(request, p1);
        vm.expectRevert(err);
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, price);
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Open), "still open");
    }
}
