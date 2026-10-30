// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice The response-age and market-hours edges on a price that the real Nodary Airnode signed, sent as P0
/// @dev The fixture's Airnode signed at `timestamp` a price that Nodary took 392 ms earlier, so its source second is
/// one before the signing second.
contract RealFixtureBoundariesTest is UnitBase {
    string constant ETH_USD_FIXTURE = "../shared/fixtures/nodary-eth-usd.json";
    bytes32 constant NODARY_ETH = keccak256("NODARY ETH");

    IVault.SignedResponse ethUsd;
    uint256 signedAt;
    uint256 priceTime;

    function setUp() public override {
        super.setUp();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(ETH_USD_FIXTURE);
        ethUsd = IVault.SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
        signedAt = ethUsd.timestamp;
        // {"price":2244.695,"updatedAt":1793381072608}
        priceTime = 1793381072;
        assertEq(signedAt, 1793381073);

        IVault.AssetProfile memory profile = ethProfile();
        profile.airnode = vm.parseJsonAddress(json, ".airnode");
        profile.priceRequestHash = ethUsd.requestHash;
        vault.setAssetProfile(NODARY_ETH, profile);
        vm.prank(user);
        vault.setRule(rule(), one(NODARY_ETH), oneRule(ethRule()), topics(1), watched());
    }

    function test_OpenTrigger_AcceptsTheRealResponseExactlyFiveMinutesAfterSigning() public {
        allowOldSourcePrices();
        vm.warp(signedAt + 5 minutes);

        uint256 triggerId = open();
        assertEq(vault.getTrigger(triggerId).p0, 2244.695e18);
        assertEq(vault.getTrigger(triggerId).t0, priceTime);
    }

    function test_RevertWhen_TheRealResponseIsFiveMinutesAndOneSecondOld() public {
        allowOldSourcePrices();
        vm.warp(signedAt + 5 minutes + 1);
        IVault.SignedResponse memory tweet = signedTweet(priceTime - 1 minutes);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, signedAt));
        vault.openTrigger(user, NODARY_ETH, tweet, ethUsd);
    }

    function test_OpenTrigger_AcceptsTheRealPriceExactlyMaxPriceAgeAfterNodaryTookIt() public {
        vm.warp(priceTime + 5 minutes);

        open();
        assertEq(vault.triggerCount(), 1);
    }

    function test_RevertWhen_TheRealPriceIsOneSecondOlderThanMaxPriceAge() public {
        // The response itself is exactly 5 min old and still accepted; the source price is 5 min + 1 s old.
        vm.warp(priceTime + 5 minutes + 1);
        IVault.SignedResponse memory tweet = signedTweet(priceTime - 1 minutes);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, priceTime));
        vault.openTrigger(user, NODARY_ETH, tweet, ethUsd);
    }

    /// @dev Lets the source price be older than the response, so that only the response age can fail
    function allowOldSourcePrices() private {
        IVault.AssetProfile memory profile = vault.getAssetProfile(NODARY_ETH);
        profile.maxPriceAge = 10 minutes;
        vault.setAssetProfile(NODARY_ETH, profile);
    }

    function open() private returns (uint256 triggerId) {
        IVault.SignedResponse memory tweet = signedTweet(priceTime - 1 minutes);
        vm.prank(agent);
        triggerId = vault.openTrigger(user, NODARY_ETH, tweet, ethUsd);
    }
}
