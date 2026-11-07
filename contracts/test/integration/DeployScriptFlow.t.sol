// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {Vault} from "../../src/vault/Vault.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// @notice The deploy script registers every asset of shared/asset-profiles.json with its Pyth feed and limits, and every
/// account of agent/config/watchlist.json, and writes the addresses
contract DeployScriptFlowTest is Test {
    string constant PROFILES = "../shared/asset-profiles.json";
    string constant WATCHLIST = "../agent/config/watchlist.json";
    string constant OUT = "../shared/deployments/e2e-forge-test.json";
    uint256 constant DEPLOYER_KEY = 0xA11CE;

    /// @dev One test, because the script reads environment variables, which tests running in parallel would share
    function test_Deploy_PicksPythAndRegistersEverything() public {
        // A local chain without Pyth gets LocalPyth.
        vm.setEnv("PYTH", vm.toString(address(0)));
        Deploy deploy = runAndCheck(true);
        assertTrue(deploy.isLocalPyth(), "local Pyth");
        assertEq(deploy.vault().pyth(), deploy.pyth());
        runAndCheck(false);

        // PYTH names another one.
        address realPyth = makeAddr("real pyth");
        vm.setEnv("PYTH", vm.toString(realPyth));
        deploy = runAndCheck(true);
        assertFalse(deploy.isLocalPyth(), "no local Pyth");
        assertEq(deploy.vault().pyth(), realPyth);

        // Base Sepolia's comes from the profiles file.
        vm.setEnv("PYTH", vm.toString(address(0)));
        vm.chainId(84532);
        assertEq(new Deploy().configuredPyth(vm.readFile(PROFILES)), 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729);
    }

    function test_AccountId_IsTheHashOfTheLowerCaseHandle() public {
        Deploy deploy = new Deploy();
        assertEq(deploy.accountId("realDonaldTrump"), keccak256("realdonaldtrump"));
        assertEq(deploy.accountId("EuphratY"), keccak256("euphraty"));
    }

    function runAndCheck(bool demoWaits) internal returns (Deploy deploy) {
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(DEPLOYER_KEY)));
        vm.setEnv("DEMO_WAITS", demoWaits ? "true" : "false");
        vm.setEnv("DEPLOYMENT_FILE", OUT);

        deploy = new Deploy();
        deploy.run();

        string memory written = vm.readFile(OUT);
        address writtenVault = vm.parseJsonAddress(written, ".vault");
        assertEq(vm.parseJsonAddress(written, ".pyth"), deploy.pyth(), "the file names Pyth");
        vm.removeFile(OUT);
        assertFalse(vm.exists(OUT), "the e2e file is gone");

        Vault vault = deploy.vault();
        assertEq(writtenVault, address(vault), "the file names the deployed vault");
        assertEq(vault.owner(), vm.addr(DEPLOYER_KEY), "the deployer owns the vault");
        assertEq(vault.dex(), address(deploy.dex()), "the vault trades on the deployed DEX");
        assertEq(vault.quoteToken(), address(deploy.usdc()), "the vault holds the deployed mock USDC");

        Deploy.AssetSpec[] memory specs = deploy.assetSpecs();
        assertEq(specs.length, 6, "six assets");
        for (uint256 i; i < specs.length; i++) {
            checkProfile(deploy, vault, specs[i].key, demoWaits);
        }
        checkAccounts(deploy, vault);
    }

    function checkProfile(Deploy deploy, Vault vault, string memory key, bool demoWaits) internal view {
        string memory profiles = vm.readFile(PROFILES);
        string memory asset = string.concat(".assets.", key);
        IVault.AssetProfile memory profile = vault.getAssetProfile(keccak256(bytes(key)));
        assertEq(profile.token, address(deploy.tokens(key)), "token");
        assertEq(profile.priceId, vm.parseJsonBytes32(profiles, string.concat(asset, ".pyth.priceId")), "feed");
        assertEq(profile.minThresholdBps, vm.parseJsonUint(profiles, string.concat(asset, ".trendThresholdBps")));
        assertEq(profile.maxSpikeCapBps, vm.parseJsonUint(profiles, string.concat(asset, ".spikeCapBps")));
        assertEq(
            profile.minWait,
            demoWaits
                ? vm.parseJsonUint(profiles, ".demoOverrides.minWaitSec")
                : vm.parseJsonUint(profiles, string.concat(asset, ".minWaitSec")),
            "minimum wait"
        );
        assertEq(profile.maxWindow, vm.parseJsonUint(profiles, string.concat(asset, ".maxWindowSec")));
        assertEq(profile.maxPriceAge, vm.parseJsonUint(profiles, ".maxPriceAgeSec"));
        assertEq(profile.maxConfBps, vm.parseJsonUint(profiles, ".maxConfBps"));
        assertEq(profile.maxStopLossBps, vm.parseJsonUint(profiles, ".maxStopLossBps"));
    }

    function checkAccounts(Deploy deploy, Vault vault) internal view {
        string[] memory handles = deploy.watchedHandles(vm.readFile(WATCHLIST));
        assertEq(handles.length, 6, "the watchlist's six accounts");
        for (uint256 i; i < handles.length; i++) {
            assertTrue(vault.isWatchableAccount(deploy.accountId(handles[i])), handles[i]);
        }
        assertFalse(vault.isWatchableAccount(keccak256("nobody")), "only the watchlist");
    }
}
