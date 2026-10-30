// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {AirnodeV2Attestation} from "../../src/lib/AirnodeV2Attestation.sol";
import {FixtureBase} from "./FixtureBase.sol";

/// @notice The four tamper tests of the spec on Person B's synthetic fixtures, at Gate 2 as the manifest intends and at a
/// sell: each rejection leaves the trigger or position open and moves nothing
contract SyntheticTamperTest is FixtureBase {
    uint256 triggerId;

    function setUp() public override {
        super.setUp();
        triggerId = openWith(user, agent, ETH, fixture("tweet-trump-venezuela"), fixture("eth-p0"));
        vm.warp(CONFIRM_AT);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Gate 2
    // ---------------------------------------------------------------------------------------------------------------

    function test_ConfirmTrigger_AcceptsTheGenuineRise() public {
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, fixture("eth-p1-rise"));

        IVault.Position memory position = vault.getPosition(positionId);
        assertEq(position.entryPrice, 2070e18, "entry price");
        assertEq(position.amount, dex.quoteBuy(address(teth), 50e6, 2070e18), "amount");
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_AValueIsEdited() public {
        // eth-p1-rise's signature over a price changed to 2170, which would pass the trend check
        IVault.SignedResponse memory edited = fixture("tamper-edited-value");
        address recovered = signerOf(edited);
        assertTrue(recovered != fixtureAirnode, "edited data still recovers the Airnode");

        expectRejectedP1(edited, abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, recovered));
    }

    function test_RevertWhen_TheResponseIsStale() public {
        IVault.SignedResponse memory stale = fixture("tamper-stale");
        assertEq(stale.timestamp, STALE_SIGNED_AT, "fixture timestamp");

        expectRejectedP1(stale, abi.encodeWithSelector(IVault.ResponseTooOld.selector, STALE_SIGNED_AT));
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        // A valid BTC/USD price from the same Airnode where the ETH request is expected
        expectRejectedP1(
            fixture("tamper-different-request"),
            abi.encodeWithSelector(IVault.WrongRequestHash.selector, ethRequest, btcRequest)
        );
    }

    function test_RevertWhen_AnotherKeySigned() public {
        assertEq(fixtureSigner("tamper-wrong-signer"), attacker, "fixture signer");

        expectRejectedP1(
            fixture("tamper-wrong-signer"),
            abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, attacker)
        );
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Selling: the same checks as the buy
    // ---------------------------------------------------------------------------------------------------------------

    function test_RevertWhen_AnEditedValueSellsAPosition() public {
        uint256 positionId = confirmGenuine();
        IVault.SignedResponse memory edited = fixture("tamper-edited-value");

        expectRejectedSell(
            positionId,
            edited,
            abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, signerOf(edited))
        );
    }

    function test_RevertWhen_AStaleResponseSellsAPosition() public {
        uint256 positionId = confirmGenuine();

        expectRejectedSell(
            positionId, fixture("tamper-stale"), abi.encodeWithSelector(IVault.ResponseTooOld.selector, STALE_SIGNED_AT)
        );
    }

    function test_RevertWhen_AnotherRequestSellsAPosition() public {
        uint256 positionId = confirmGenuine();

        expectRejectedSell(
            positionId,
            fixture("tamper-different-request"),
            abi.encodeWithSelector(IVault.WrongRequestHash.selector, ethRequest, btcRequest)
        );
    }

    function test_RevertWhen_AnotherKeySellsAPosition() public {
        uint256 positionId = confirmGenuine();

        expectRejectedSell(
            positionId,
            fixture("tamper-wrong-signer"),
            abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, attacker)
        );
    }

    /// @dev The rejected P1 moves nothing and keeps the trigger open, and the genuine eth-p1-rise still confirms it
    function expectRejectedP1(IVault.SignedResponse memory p1, bytes memory expectedError) private {
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(expectedError);
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        confirmGenuine();
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    /// @dev The owner's manual sell at the tampered price reverts, and the position keeps its tokens
    function expectRejectedSell(uint256 positionId, IVault.SignedResponse memory price, bytes memory expectedError)
        private
    {
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(expectedError);
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    function confirmGenuine() private returns (uint256 positionId) {
        vm.prank(keeper);
        positionId = vault.confirmTrigger(triggerId, fixture("eth-p1-rise"));
    }
}

/// @notice Replay of the same signed response by the same user, on the synthetic fixtures: each P0 and P1 serves one
/// trigger of a user, and the guard is per user, so another user can use the same response
contract SyntheticReplayTest is FixtureBase {
    function setUp() public override {
        super.setUp();
        setSyntheticRule(user, agent, accountList(trumpAccount, muskAccount));
        fund(user2, 1_000e6);
        setSyntheticRule(user2, agent2, accountList(trumpAccount));
    }

    function test_RevertWhen_TheSameUserReusesAP0() public {
        IVault.SignedResponse memory p0 = fixture("eth-p0");
        openWith(user, agent, ETH, fixture("tweet-trump-venezuela"), p0);
        Books memory before = books();

        // A second post, otherwise valid, with the P0 that already opened a trigger
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseAlreadyUsed.selector, responseHash(p0)));
        vault.openTrigger(user, ETH, fixture("tweet-musk-doge"), p0);
        assertBooks(books(), before);

        // The same post with a P0 that has not been used opens a trigger
        uint256 triggerId = openWith(user, agent, ETH, fixture("tweet-musk-doge"), fixture("eth-p1-early"));
        assertEq(vault.getTrigger(triggerId).t0, T1_EARLY, "t0");
    }

    function test_RevertWhen_TheSameUserReusesAP1() public {
        uint256 first = openWith(user, agent, ETH, fixture("tweet-trump-venezuela"), fixture("eth-p0"));
        // No P0 fixture is left for the second post, so the fixture Airnode signs one: 2000 just before OPEN_AT
        uint256 second = openWith(user, agent, ETH, fixture("tweet-musk-doge"), fixtureKeyPrice("2000", OPEN_AT - 1));
        vm.warp(CONFIRM_AT);
        IVault.SignedResponse memory p1 = fixture("eth-p1-rise");
        vm.prank(keeper);
        vault.confirmTrigger(first, p1);
        Books memory before = books();

        // The second trigger passes every other check with this P1: 2070 is +3.5% over 2000, 231 s after its P0.
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseAlreadyUsed.selector, responseHash(p1)));
        vault.confirmTrigger(second, p1);
        assertBooks(books(), before);
        assertTriggerStatus(second, IVault.TriggerStatus.Open);

        // A fresh P1 confirms it.
        vm.prank(keeper);
        vault.confirmTrigger(second, fixtureKeyPrice("2070", CONFIRM_AT));
        assertTriggerStatus(second, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_TheSameUserReusesAP1ForTheSameTrigger() public {
        uint256 triggerId = openWith(user, agent, ETH, fixture("tweet-trump-venezuela"), fixture("eth-p0"));
        vm.warp(CONFIRM_AT);
        IVault.SignedResponse memory p1 = fixture("eth-p1-rise");
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, p1);
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVault.TriggerNotOpen.selector, triggerId));
        vault.confirmTrigger(triggerId, p1);
        assertBooks(books(), before);
    }

    function test_OpenTriggerAndConfirmTrigger_AcceptTheSameResponsesForAnotherUser() public {
        IVault.SignedResponse memory tweet = fixture("tweet-trump-venezuela");
        IVault.SignedResponse memory p0 = fixture("eth-p0");
        uint256 first = openWith(user, agent, ETH, tweet, p0);
        uint256 second = openWith(user2, agent2, ETH, tweet, p0);
        vm.warp(CONFIRM_AT);
        IVault.SignedResponse memory p1 = fixture("eth-p1-rise");

        vm.startPrank(keeper);
        uint256 firstPosition = vault.confirmTrigger(first, p1);
        uint256 secondPosition = vault.confirmTrigger(second, p1);
        vm.stopPrank();

        assertEq(vault.getPosition(firstPosition).user, user, "first owner");
        assertEq(vault.getPosition(secondPosition).user, user2, "second owner");
        assertEq(vault.balanceOf(user), 950e6, "user's balance");
        assertEq(vault.balanceOf(user2), 950e6, "user2's balance");
    }
}

/// @notice The four tamper tests and same-user replay on responses that the real Nodary Airnode signed, sent as P0 at
/// Gate 1 (the only place a genuine Nodary signature fits: P1 would need a second Nodary price 30 minutes later)
/// @dev The post is signed with the base's test tweet Airnode. The root FixtureTamperTest covers three of these cases
/// on the stub DEX; here they run on the real MockDEX together with the wrong-signer and replay cases.
contract NodaryTamperTest is FixtureBase {
    bytes32 constant NODARY_ETH = keccak256("NODARY ETH");

    IVault.SignedResponse ethUsd;
    address nodary;
    // Time at which Nodary took the price: its updatedAt in seconds
    uint256 t0;

    function setUp() public override {
        super.setUp();
        ethUsd = readFixture(NODARY_ETH_USD);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        nodary = vm.parseJsonAddress(vm.readFile(NODARY_ETH_USD), ".airnode");
        // Nodary writes updatedAt in milliseconds
        t0 = vm.parseJsonUint(string(ethUsd.data), ".updatedAt") / 1000;
        assertEq(t0, 1793381072, "fixture's updatedAt");

        IVault.AssetProfile memory profile = ethProfile();
        profile.airnode = nodary;
        profile.priceRequestHash = ethUsd.requestHash;
        vault.setAssetProfile(NODARY_ETH, profile);
        vm.prank(user);
        vault.setRule(rule(), one(NODARY_ETH), oneRule(ethRule()), topics(1), watched());
        fund(user2, 1_000e6);
        vm.prank(user2);
        vault.setRule(ruleFor(agent2), one(NODARY_ETH), oneRule(ethRule()), topics(1), watched());

        vm.warp(ethUsd.timestamp + 10);
    }

    function test_OpenTrigger_AcceptsTheGenuineResponse() public {
        uint256 triggerId = open(user, agent, 1 minutes, ethUsd);

        IVault.Trigger memory trigger = vault.getTrigger(triggerId);
        assertEq(trigger.p0, 2244.695e18, "p0");
        assertEq(trigger.t0, t0, "t0");
    }

    function test_RevertWhen_AValueIsEdited() public {
        IVault.SignedResponse memory edited = readFixture(NODARY_ETH_USD);
        // {"price":2244.695,...}: the first digit of the price
        assertEq(edited.data[9], bytes1("2"), "first digit");
        edited.data[9] = "1";

        expectRejectedP0(
            edited, abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, signerOf(edited))
        );
    }

    function test_RevertWhen_TheResponseIsStale() public {
        vm.warp(ethUsd.timestamp + vault.MAX_RESPONSE_AGE() + 1);

        expectRejectedP0(ethUsd, abi.encodeWithSelector(IVault.ResponseTooOld.selector, ethUsd.timestamp));
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        IVault.SignedResponse memory btcUsd = readFixture(NODARY_BTC_USD);

        expectRejectedP0(
            btcUsd, abi.encodeWithSelector(IVault.WrongRequestHash.selector, ethUsd.requestHash, btcUsd.requestHash)
        );
    }

    function test_RevertWhen_TheRequestHashIsSwappedToTheExpectedOne() public {
        IVault.SignedResponse memory swapped = readFixture(NODARY_BTC_USD);
        swapped.requestHash = ethUsd.requestHash;

        expectRejectedP0(
            swapped, abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, signerOf(swapped))
        );
    }

    function test_RevertWhen_AnotherKeySigned() public {
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        // The genuine bytes, request and timestamp, signed with our own key
        IVault.SignedResponse memory forged = sign(impostorKey, ethUsd.requestHash, ethUsd.timestamp, ethUsd.data);

        expectRejectedP0(forged, abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
    }

    function test_RevertWhen_TheSameUserReusesTheResponse() public {
        open(user, agent, 1 minutes, ethUsd);
        Books memory before = books();

        // Another post of the same account, two minutes before the price
        IVault.SignedResponse memory tweet = signedTweetWithId(ACCOUNT, tweetIdAt(t0 - 2 minutes));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseAlreadyUsed.selector, responseHash(ethUsd)));
        vault.openTrigger(user, NODARY_ETH, tweet, ethUsd);

        assertBooks(books(), before);
    }

    function test_OpenTrigger_AcceptsTheSameResponseForAnotherUser() public {
        open(user, agent, 1 minutes, ethUsd);

        uint256 triggerId = open(user2, agent2, 1 minutes, ethUsd);

        assertEq(vault.getTrigger(triggerId).user, user2, "trigger owner");
        assertEq(vault.triggerCount(), 2, "trigger count");
    }

    /// @dev The rejected P0 opens nothing, and the genuine response still opens a trigger afterwards
    function expectRejectedP0(IVault.SignedResponse memory p0, bytes memory expectedError) private {
        IVault.SignedResponse memory tweet = signedTweetWithId(ACCOUNT, tweetIdAt(t0 - 1 minutes));

        vm.prank(agent);
        vm.expectRevert(expectedError);
        vault.openTrigger(user, NODARY_ETH, tweet, p0);
        assertEq(vault.triggerCount(), 0, "trigger count");

        if (block.timestamp <= ethUsd.timestamp + vault.MAX_RESPONSE_AGE()) {
            open(user, agent, 1 minutes, ethUsd);
            assertEq(vault.triggerCount(), 1, "trigger count after the genuine response");
        }
    }

    /// @dev Opens a trigger for `who` with a post from `before` ahead of Nodary's price
    function open(address who, address agent_, uint256 before, IVault.SignedResponse memory p0)
        private
        returns (uint256 triggerId)
    {
        IVault.SignedResponse memory tweet = signedTweetWithId(ACCOUNT, tweetIdAt(t0 - before));
        triggerId = openWith(who, agent_, NODARY_ETH, tweet, p0);
    }
}
