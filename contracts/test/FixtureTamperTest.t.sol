// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../src/interfaces/IVault.sol";
import {AirnodeV2Attestation} from "../src/lib/AirnodeV2Attestation.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice The tamper test on real responses that the Nodary Airnode v2 signed, sent as P0 at Gate 1
/// @dev The wrong-signer case needs no fixture, so it lives in TamperTest with vm.sign.
contract FixtureTamperTest is VaultTestBase {
    // TODO: Person B delivers these in shared/fixtures/, saved with `pnpm --silent fetch-response <feed name>`. Until
    // the files exist, every test here skips.
    string constant ETH_USD_FIXTURE = "../shared/fixtures/nodary-eth-usd.json";
    string constant BTC_USD_FIXTURE = "../shared/fixtures/nodary-btc-usd.json";

    bytes32 constant NODARY_ETH = keccak256("NODARY ETH");

    IVault.SignedResponse ethUsd;

    function setUp() public override {
        if (!exists(ETH_USD_FIXTURE) || !exists(BTC_USD_FIXTURE)) {
            vm.skip(true);
            return;
        }
        super.setUp();
        ethUsd = readFixture(ETH_USD_FIXTURE);

        // An asset whose price comes from the real Nodary Airnode, for the fixture's request
        IVault.AssetProfile memory profile = ethProfile();
        profile.airnode = vm.parseJsonAddress(vm.readFile(ETH_USD_FIXTURE), ".airnode");
        profile.priceRequestHash = ethUsd.requestHash;
        vault.setAssetProfile(NODARY_ETH, profile);
        bytes32[] memory assetIds = new bytes32[](1);
        assetIds[0] = NODARY_ETH;
        IVault.AssetRule[] memory assetRules = new IVault.AssetRule[](1);
        assetRules[0] = ethRule();
        vm.prank(user);
        vault.setRule(rule(), assetIds, assetRules, topics(1), watched());

        vm.warp(ethUsd.timestamp + 10);
    }

    function test_AcceptsTheRealResponse() public {
        open(ethUsd);
        assertEq(vault.triggerCount(), 1);
    }

    function test_RevertWhen_AValueIsEdited() public {
        IVault.SignedResponse memory edited = ethUsd;
        // Changes the first digit of the price
        edited.data[9] = edited.data[9] == "1" ? bytes1("2") : bytes1("1");

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        open(edited);
    }

    function test_RevertWhen_TheResponseIsTooOld() public {
        vm.warp(ethUsd.timestamp + vault.MAX_RESPONSE_AGE() + 1);

        vm.expectRevert(abi.encodeWithSelector(IVault.ResponseTooOld.selector, ethUsd.timestamp));
        open(ethUsd);
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        IVault.SignedResponse memory btcUsd = readFixture(BTC_USD_FIXTURE);

        vm.expectRevert(
            abi.encodeWithSelector(IVault.WrongRequestHash.selector, ethUsd.requestHash, btcUsd.requestHash)
        );
        open(btcUsd);
    }

    /// @dev Opens a trigger with a post from one minute before the fixture's price
    function open(IVault.SignedResponse memory p0) private {
        uint256 priceTime = ethUsd.timestamp;
        IVault.SignedResponse memory tweet = signedTweet(priceTime - 1 minutes);
        vm.prank(agent);
        vault.openTrigger(user, NODARY_ETH, tweet, p0);
    }

    /// @dev Foundry refuses to read below a directory that does not exist yet, instead of returning false.
    function exists(string memory path) private view returns (bool) {
        try vm.exists(path) returns (bool doesExist) {
            return doesExist;
        } catch {
            return false;
        }
    }

    function readFixture(string memory path) private view returns (IVault.SignedResponse memory) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(path);
        return IVault.SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }
}
