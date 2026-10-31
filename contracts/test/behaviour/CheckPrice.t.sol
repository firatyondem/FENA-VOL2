// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {AirnodeV2Attestation} from "../../src/lib/AirnodeV2Attestation.sol";
import {FixtureBase} from "./FixtureBase.sol";

/// @notice The judges' read-only check: the spec's four tamper tests with no trigger open and no wallet behind the call,
/// refused for the same reasons as a real buy
contract CheckPriceTest is FixtureBase {
    function setUp() public override {
        super.setUp();
        vm.warp(CONFIRM_AT);
        assertEq(vault.triggerCount(), 0, "no trigger is open");
    }

    function test_ReadsTheGenuinePriceAndItsTime() public view {
        (uint256 price, uint256 priceTime) = vault.checkPrice(ETH, fixture("eth-p1-rise"));

        assertEq(price, 2070e18, "price");
        assertEq(priceTime, T1, "price time");
    }

    function test_AnyoneMayCheck() public {
        vm.prank(makeAddr("judge"));
        (uint256 price,) = vault.checkPrice(ETH, fixture("eth-p1-rise"));

        assertEq(price, 2070e18, "price");
    }

    function test_MovesNothingAndLeavesTheResponseUnused() public {
        vm.warp(OPEN_AT);
        uint256 triggerId = openWith(user, agent, ETH, fixture("tweet-trump-venezuela"), fixture("eth-p0"));
        vm.warp(CONFIRM_AT);
        IVault.SignedResponse memory p1 = fixture("eth-p1-rise");
        Books memory before = books();

        vault.checkPrice(ETH, p1);
        vault.checkPrice(ETH, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        vm.prank(keeper);
        vault.confirmTrigger(triggerId, p1);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Confirmed);
    }

    function test_RevertWhen_AValueIsEdited() public {
        IVault.SignedResponse memory edited = fixture("tamper-edited-value");

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, signerOf(edited)));
        vault.checkPrice(ETH, edited);
    }

    function test_RevertWhen_TheResponseIsStale() public {
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, STALE_SIGNED_AT));
        vault.checkPrice(ETH, fixture("tamper-stale"));
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        vm.expectRevert(abi.encodeWithSelector(IVault.WrongRequestHash.selector, ethRequest, btcRequest));
        vault.checkPrice(ETH, fixture("tamper-different-request"));
    }

    function test_RevertWhen_AnotherKeySigned() public {
        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, attacker));
        vault.checkPrice(ETH, fixture("tamper-wrong-signer"));
    }

    function test_RevertWhen_ThePriceIsOlderThanTheProfileAllows() public {
        // Signed just now, over a price the source took just past the limit: the market is closed or the feed is stale
        uint256 updatedAt = block.timestamp - vault.getAssetProfile(ETH).maxPriceAge - 1;
        IVault.SignedResponse memory stalePrice = fixtureKeyPrice("2070", updatedAt);

        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, updatedAt));
        vault.checkPrice(ETH, stalePrice);
    }

    function test_RevertWhen_TheAssetIsNotRegistered() public {
        bytes32 unknown = keccak256("UNKNOWN");
        IVault.SignedResponse memory p1 = fixture("eth-p1-rise");

        vm.expectRevert(abi.encodeWithSelector(IVault.AssetNotRegistered.selector, unknown));
        vault.checkPrice(unknown, p1);
    }
}
