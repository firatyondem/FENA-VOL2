// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IVault} from "../src/interfaces/IVault.sol";
import {MockAssetToken} from "../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../src/mocks/MockDEX.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {Vault} from "../src/vault/Vault.sol";

/// @title Deploys the mocks and the vault, and registers every asset and watched account
/// @notice From contracts/, with PRIVATE_KEY set and `npm run request-hashes` run in agent/ first:
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
/// Reads shared/asset-profiles.json and shared/deployments/request-hashes.json, and writes the addresses to
/// shared/deployments/<chain id>.json.
///   DEMO_WAITS=false   profiles keep the spec's minimum waits (30 min to 1 h) instead of the 2-minute stage demo
///   FIXTURE_AIRNODES=true   registers the public fixture key as every Airnode, for local tests with signed fixtures
///   DEPLOYMENT_FILE=...   writes the addresses elsewhere under ../shared/deployments/
contract Deploy is Script {
    string internal constant PROFILES = "../shared/asset-profiles.json";
    string internal constant REQUEST_HASHES = "../shared/deployments/request-hashes.json";
    string internal constant FIXTURE_MANIFEST = "../shared/fixtures/synthetic/manifest.json";

    struct AssetSpec {
        string key;
        string name;
        string symbol;
    }

    MockUSDC public usdc;
    MockDEX public dex;
    Vault public vault;
    mapping(string key => MockAssetToken) public tokens;

    function assetSpecs() public pure returns (AssetSpec[] memory specs) {
        specs = new AssetSpec[](5);
        specs[0] = AssetSpec("OIL", "Test Crude Oil", "tOIL");
        specs[1] = AssetSpec("DOGE", "Test Dogecoin", "tDOGE");
        specs[2] = AssetSpec("ETH", "Test Ether", "tETH");
        specs[3] = AssetSpec("BTC", "Test Bitcoin", "tBTC");
        specs[4] = AssetSpec("TSLA", "Test Tesla", "tTSLA");
    }

    /// @notice The asset id the vault and the agent use: keccak256 of the asset's key, such as "OIL"
    function assetId(string memory key) public pure returns (bytes32) {
        return keccak256(bytes(key));
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        bool demoWaits = vm.envOr("DEMO_WAITS", true);
        bool fixtureAirnodes = vm.envOr("FIXTURE_AIRNODES", false);
        string memory profiles = vm.readFile(PROFILES);
        string memory hashes = vm.readFile(REQUEST_HASHES);
        address fixtureAirnode =
            fixtureAirnodes ? vm.parseJsonAddress(vm.readFile(FIXTURE_MANIFEST), ".fixtureAirnode.address") : address(0);
        AssetSpec[] memory specs = assetSpecs();

        vm.startBroadcast(deployerKey);
        usdc = new MockUSDC();
        dex = new MockDEX(usdc, deployer);
        vault = new Vault(deployer, address(dex));
        for (uint256 i = 0; i < specs.length; i++) {
            MockAssetToken token = new MockAssetToken(specs[i].name, specs[i].symbol, 18, address(dex));
            dex.listAsset(token);
            tokens[specs[i].key] = token;
            vault.setAssetProfile(
                assetId(specs[i].key),
                assetProfile(profiles, hashes, specs[i].key, address(token), demoWaits, fixtureAirnode)
            );
        }
        string[] memory handles = vm.parseJsonKeys(hashes, ".posts");
        for (uint256 i = 0; i < handles.length; i++) {
            string memory path = string.concat(".posts.", handles[i]);
            address airnode =
                fixtureAirnode != address(0) ? fixtureAirnode : vm.parseJsonAddress(hashes, string.concat(path, ".airnode"));
            vault.setWatchableAccount(vm.parseJsonBytes32(hashes, string.concat(path, ".requestHash")), airnode);
        }
        vm.stopBroadcast();

        writeDeployment(deployer, specs, fixtureAirnodes);
    }

    /// @notice The limits from the spec's asset profile: a rule may be stricter, never looser
    function assetProfile(
        string memory profiles,
        string memory hashes,
        string memory key,
        address token,
        bool demoWaits,
        address fixtureAirnode
    ) public pure returns (IVault.AssetProfile memory profile) {
        string memory asset = string.concat(".assets.", key);
        string memory price = string.concat(".prices.", key);
        profile.token = token;
        profile.airnode =
            fixtureAirnode != address(0) ? fixtureAirnode : vm.parseJsonAddress(hashes, string.concat(price, ".airnode"));
        profile.priceRequestHash = vm.parseJsonBytes32(hashes, string.concat(price, ".requestHash"));
        profile.minThresholdBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".trendThresholdBps")));
        profile.maxSpikeCapBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".spikeCapBps")));
        profile.minWait = uint32(
            demoWaits
                ? vm.parseJsonUint(profiles, ".demoOverrides.minWaitSec")
                : vm.parseJsonUint(profiles, string.concat(asset, ".minWaitSec"))
        );
        profile.maxWindow = uint32(vm.parseJsonUint(profiles, string.concat(asset, ".maxWindowSec")));
        profile.maxPriceAge = uint32(vm.parseJsonUint(profiles, ".maxPriceAgeSec"));
        profile.updatedAtInMs =
            keccak256(bytes(vm.parseJsonString(profiles, string.concat(asset, ".price.timeUnit")))) == keccak256("ms");
    }

    function writeDeployment(address deployer, AssetSpec[] memory specs, bool fixtureAirnodes) internal {
        string memory tokensJson;
        string memory idsJson;
        for (uint256 i = 0; i < specs.length; i++) {
            tokensJson = vm.serializeAddress("tokens", specs[i].key, address(tokens[specs[i].key]));
            idsJson = vm.serializeBytes32("assetIds", specs[i].key, assetId(specs[i].key));
        }
        vm.serializeUint("deployment", "chainId", block.chainid);
        vm.serializeUint("deployment", "deployedAtBlock", block.number);
        vm.serializeAddress("deployment", "deployer", deployer);
        vm.serializeAddress("deployment", "usdc", address(usdc));
        vm.serializeAddress("deployment", "dex", address(dex));
        vm.serializeAddress("deployment", "vault", address(vault));
        vm.serializeBool("deployment", "fixtureAirnodes", fixtureAirnodes);
        vm.serializeString("deployment", "assetIds", idsJson);
        string memory json = vm.serializeString("deployment", "assets", tokensJson);
        string memory defaultFile = string.concat("../shared/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, vm.envOr("DEPLOYMENT_FILE", defaultFile));
    }
}
