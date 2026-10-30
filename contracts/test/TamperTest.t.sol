// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../src/interfaces/IVault.sol";
import {AirnodeV2Attestation} from "../src/lib/AirnodeV2Attestation.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice The demo: one valid run and the four rejections of the hackathon tamper test, here on P1 at Gate 2
contract TamperTest is VaultTestBase {
    uint256 triggerId;

    function setUp() public override {
        super.setUp();
        triggerId = openEthTrigger("2000");
        vm.warp(block.timestamp + 31 minutes);
    }

    function test_ValidRun_BuysAtTheSignedPrice() public {
        IVault.SignedResponse memory p1 = signedPrice("2070");

        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, p1);

        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.user, user);
        assertEq(position.entryPrice, 2070e18);
        assertEq(position.cost, 50e6);
        // 50 USDC at 2070 USDC per ETH
        assertEq(position.amount, uint256(50e18) / 2070);
        assertEq(teth.balanceOf(address(vault)), position.amount);
        assertEq(vault.balanceOf(user), 950e6);
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Confirmed));
    }

    function test_RevertWhen_AValueIsEdited() public {
        IVault.SignedResponse memory p1 = signedPrice("2070");
        p1.data = priceData("2170", block.timestamp);

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheResponseIsTooOld() public {
        IVault.SignedResponse memory p1 = signedPrice("2070");
        vm.warp(block.timestamp + vault.MAX_RESPONSE_AGE() + 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, p1.timestamp));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        // A real response from the same Airnode, but for BTC/USD
        IVault.SignedResponse memory p1 =
            sign(priceAirnodeKey, BTC_PRICE_REQUEST, block.timestamp, priceData("70000", block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(IVault.WrongRequestHash.selector, ETH_PRICE_REQUEST, BTC_PRICE_REQUEST));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_TheRequestHashIsSwappedToTheExpectedOne() public {
        // The same BTC/USD response, with its request hash replaced to get past the comparison
        IVault.SignedResponse memory p1 =
            sign(priceAirnodeKey, BTC_PRICE_REQUEST, block.timestamp, priceData("2070", block.timestamp));
        p1.requestHash = ETH_PRICE_REQUEST;

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vault.confirmTrigger(triggerId, p1);
    }

    function test_RevertWhen_AnotherKeySigned() public {
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        IVault.SignedResponse memory p1 =
            sign(impostorKey, ETH_PRICE_REQUEST, block.timestamp, priceData("2070", block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        vault.confirmTrigger(triggerId, p1);
    }

    function test_TheTriggerStaysOpenAfterARejection() public {
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        IVault.SignedResponse memory forged =
            sign(impostorKey, ETH_PRICE_REQUEST, block.timestamp, priceData("2070", block.timestamp));
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vault.confirmTrigger(triggerId, forged);

        vault.confirmTrigger(triggerId, signedPrice("2070"));
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(IVault.TriggerStatus.Confirmed));
    }
}

/// @notice The four rejections at Gate 1, on the post and on P0
contract GateOneTamperTest is VaultTestBase {
    function test_RevertWhen_ThePostIsEdited() public {
        vm.warp(block.timestamp + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(block.timestamp - 1 minutes);
        tweet.data = bytes(string.concat('{"id":"', vm.toString(tweetIdAt(block.timestamp - 2 minutes)), '"}'));
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_P0IsTooOld() public {
        IVault.SignedResponse memory p0 = signedPrice("2000");
        vm.warp(block.timestamp + vault.MAX_RESPONSE_AGE() + 1);
        IVault.SignedResponse memory tweet = signedTweet(block.timestamp - 6 minutes);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, p0.timestamp));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_P0AnswersAnotherRequest() public {
        vm.warp(block.timestamp + 1 minutes);
        IVault.SignedResponse memory tweet = signedTweet(block.timestamp - 1 minutes);
        IVault.SignedResponse memory p0 =
            sign(priceAirnodeKey, BTC_PRICE_REQUEST, block.timestamp, priceData("70000", block.timestamp));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.WrongRequestHash.selector, ETH_PRICE_REQUEST, BTC_PRICE_REQUEST));
        vault.openTrigger(user, ETH, tweet, p0);
    }

    function test_RevertWhen_AnotherKeySignedThePost() public {
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        vm.warp(block.timestamp + 1 minutes);
        uint256 tweetId = tweetIdAt(block.timestamp - 1 minutes);
        IVault.SignedResponse memory tweet =
            sign(impostorKey, ACCOUNT, block.timestamp, bytes(string.concat('{"id":"', vm.toString(tweetId), '"}')));
        IVault.SignedResponse memory p0 = signedPrice("2000");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        vault.openTrigger(user, ETH, tweet, p0);
    }
}
