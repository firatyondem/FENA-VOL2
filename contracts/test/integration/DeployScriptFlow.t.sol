// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {Vault} from "../../src/vault/Vault.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// @notice Integration flow 7: Person B's deploy script, run without broadcasting, sets every profile of
/// shared/asset-profiles.json and registers every watched account of shared/deployments/request-hashes.json
/// @dev The expected values are read straight from those two files, not from the script. The script writes its addresses
/// to an e2e-*.json file, which .gitignore ignores, and the test removes it at once. Everything runs in one test
/// function, one mode after the other, because the script reads its settings from process-wide environment variables
/// and Forge runs test functions in parallel.
contract DeployScriptFlowTest is Test {
    string constant PROFILES = "../shared/asset-profiles.json";
    string constant HASHES = "../shared/deployments/request-hashes.json";
    string constant MANIFEST = "../shared/fixtures/synthetic/manifest.json";
    string constant OUT = "../shared/deployments/e2e-forge-test.json";
    uint256 constant DEPLOYER_KEY = 0xA11CE;

    function test_Deploy_SetsEveryProfileAndAccountInAllFourModes() public {
        runAndCheck(true, true);
        runAndCheck(false, true);
        runAndCheck(true, false);
        runAndCheck(false, false);
    }

    function runAndCheck(bool demoWaits, bool fixtureAirnodes) internal {
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(DEPLOYER_KEY)));
        vm.setEnv("DEMO_WAITS", demoWaits ? "true" : "false");
        vm.setEnv("FIXTURE_AIRNODES", fixtureAirnodes ? "true" : "false");
        vm.setEnv("DEPLOYMENT_FILE", OUT);

        Deploy deploy = new Deploy();
        deploy.run();

        // The script wrote the addresses. Read the vault out of the file, and remove the file before anything can fail.
        address writtenVault = vm.parseJsonAddress(vm.readFile(OUT), ".vault");
        vm.removeFile(OUT);
        assertFalse(vm.exists(OUT), "the e2e file is gone");

        Vault vault = deploy.vault();
        assertEq(writtenVault, address(vault), "the file names the deployed vault");
        assertEq(vault.owner(), vm.addr(DEPLOYER_KEY), "the deployer owns the vault");
        assertEq(vault.dex(), address(deploy.dex()), "the vault trades on the deployed DEX");
        assertEq(vault.quoteToken(), address(deploy.usdc()), "the vault holds the deployed mock USDC");

        address fixtureAirnode =
            fixtureAirnodes ? vm.parseJsonAddress(vm.readFile(MANIFEST), ".fixtureAirnode.address") : address(0);
        Deploy.AssetSpec[] memory specs = deploy.assetSpecs();
        assertEq(specs.length, 5, "five assets");
        for (uint256 i; i < specs.length; i++) {
            checkProfile(deploy, vault, specs[i].key, demoWaits, fixtureAirnode);
        }
        checkAccounts(vault, fixtureAirnode);
    }

    function checkProfile(Deploy deploy, Vault vault, string memory key, bool demoWaits, address fixtureAirnode)
        internal
        view
    {
        string memory profiles = vm.readFile(PROFILES);
        string memory hashes = vm.readFile(HASHES);
        string memory asset = string.concat(".assets.", key);
        string memory price = string.concat(".prices.", key);
        IVault.AssetProfile memory profile = vault.getAssetProfile(keccak256(bytes(key)));

        address token = address(deploy.tokens(key));
        assertTrue(token != address(0), key);
        assertEq(profile.token, token, string.concat(key, ": token"));
        assertTrue(deploy.dex().isListed(token), string.concat(key, ": listed on the DEX"));
        assertEq(
            profile.airnode,
            fixtureAirnode != address(0)
                ? fixtureAirnode
                : vm.parseJsonAddress(hashes, string.concat(price, ".airnode")),
            string.concat(key, ": airnode")
        );
        assertEq(
            profile.priceRequestHash,
            vm.parseJsonBytes32(hashes, string.concat(price, ".requestHash")),
            string.concat(key, ": request hash")
        );
        assertEq(
            profile.minThresholdBps,
            vm.parseJsonUint(profiles, string.concat(asset, ".trendThresholdBps")),
            string.concat(key, ": threshold")
        );
        assertEq(
            profile.maxSpikeCapBps,
            vm.parseJsonUint(profiles, string.concat(asset, ".spikeCapBps")),
            string.concat(key, ": spike cap")
        );
        assertEq(
            profile.minWait,
            demoWaits
                ? vm.parseJsonUint(profiles, ".demoOverrides.minWaitSec")
                : vm.parseJsonUint(profiles, string.concat(asset, ".minWaitSec")),
            string.concat(key, ": minimum wait")
        );
        assertEq(
            profile.maxWindow,
            vm.parseJsonUint(profiles, string.concat(asset, ".maxWindowSec")),
            string.concat(key, ": maximum window")
        );
        assertEq(
            profile.maxPriceAge, vm.parseJsonUint(profiles, ".maxPriceAgeSec"), string.concat(key, ": max price age")
        );
        assertEq(
            keccak256(bytes(vm.parseJsonString(profiles, string.concat(asset, ".price.timeUnit")))),
            keccak256("ms"),
            string.concat(key, ": the file writes milliseconds")
        );
        assertTrue(profile.updatedAtInMs, string.concat(key, ": updatedAt in milliseconds"));
    }

    function checkAccounts(Vault vault, address fixtureAirnode) internal view {
        string memory hashes = vm.readFile(HASHES);
        string[] memory handles = vm.parseJsonKeys(hashes, ".posts");
        assertEq(handles.length, 5, "five watched accounts");
        for (uint256 i; i < handles.length; i++) {
            string memory path = string.concat(".posts.", handles[i]);
            address expected = fixtureAirnode != address(0)
                ? fixtureAirnode
                : vm.parseJsonAddress(hashes, string.concat(path, ".airnode"));
            assertEq(
                vault.getWatchableAccount(vm.parseJsonBytes32(hashes, string.concat(path, ".requestHash"))),
                expected,
                handles[i]
            );
        }
    }
}
