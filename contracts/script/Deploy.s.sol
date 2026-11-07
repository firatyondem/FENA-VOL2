// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IVault} from "../src/interfaces/IVault.sol";
import {LocalPyth} from "../src/mocks/LocalPyth.sol";
import {MockAssetToken} from "../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../src/mocks/MockDEX.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {Vault} from "../src/vault/Vault.sol";

/// @title Deploys the mocks and the vault, and registers every asset and watched account
/// @notice From contracts/, with PRIVATE_KEY set:
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
/// Reads shared/asset-profiles.json and agent/config/watchlist.json, and writes the addresses to
/// shared/deployments/<chain id>.json.
///   DEMO_WAITS=false   profiles keep the spec's minimum waits (30 min to 1 h) instead of the 2-minute stage demo
///   PYTH=0x...   the Pyth contract to verify prices with. Without it, the script takes the chain's Pyth from the
///                profiles file, and on a chain with none (a plain local chain) deploys LocalPyth, which checks no
///                signatures.
///   DEPLOYMENT_FILE=...   writes the addresses elsewhere under ../shared/deployments/
contract Deploy is Script {
    string internal constant PROFILES = "../shared/asset-profiles.json";
    string internal constant WATCHLIST = "../agent/config/watchlist.json";

    struct AssetSpec {
        string key;
        string name;
        string symbol;
    }

    MockUSDC public usdc;
    MockDEX public dex;
    Vault public vault;
    address public pyth;
    bool public isLocalPyth;
    mapping(string key => MockAssetToken) public tokens;

    function assetSpecs() public pure returns (AssetSpec[] memory specs) {
        specs = new AssetSpec[](6);
        specs[0] = AssetSpec("OIL", "Test Crude Oil", "tOIL");
        specs[1] = AssetSpec("DOGE", "Test Dogecoin", "tDOGE");
        specs[2] = AssetSpec("ETH", "Test Ether", "tETH");
        specs[3] = AssetSpec("BTC", "Test Bitcoin", "tBTC");
        specs[4] = AssetSpec("TSLA", "Test Tesla", "tTSLA");
        specs[5] = AssetSpec("SPY", "Test S&P 500 ETF", "tSPY");
    }

    /// @notice The asset id the vault and the agent use: keccak256 of the asset's key, such as "OIL"
    function assetId(string memory key) public pure returns (bytes32) {
        return keccak256(bytes(key));
    }

    /// @notice The account id the vault and the agent use: keccak256 of the lower-case handle
    function accountId(string memory handle) public pure returns (bytes32) {
        bytes memory text = bytes(handle);
        for (uint256 i; i < text.length; i++) {
            if (text[i] >= "A" && text[i] <= "Z") text[i] = bytes1(uint8(text[i]) + 32);
        }
        return keccak256(text);
    }

    /// @notice The handles of the watchlist, in its order
    function watchedHandles(string memory watchlist) public view returns (string[] memory handles) {
        uint256 count;
        while (vm.keyExistsJson(watchlist, string.concat("$[", vm.toString(count), "].handle"))) count++;
        handles = new string[](count);
        for (uint256 i; i < count; i++) {
            handles[i] = vm.parseJsonString(watchlist, string.concat("$[", vm.toString(i), "].handle"));
        }
    }

    /// @notice The Pyth contract for this chain: PYTH, else the profiles file's entry, else none (address 0)
    function configuredPyth(string memory profiles) public view returns (address) {
        address fromEnv = vm.envOr("PYTH", address(0));
        if (fromEnv != address(0)) return fromEnv;
        string memory key = string.concat(".pyth.contracts.", vm.toString(block.chainid));
        return vm.keyExistsJson(profiles, key) ? vm.parseJsonAddress(profiles, key) : address(0);
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        bool demoWaits = vm.envOr("DEMO_WAITS", true);
        string memory profiles = vm.readFile(PROFILES);
        string memory watchlist = vm.readFile(WATCHLIST);
        AssetSpec[] memory specs = assetSpecs();
        pyth = configuredPyth(profiles);

        vm.startBroadcast(deployerKey);
        if (pyth == address(0)) {
            pyth = address(new LocalPyth(0));
            isLocalPyth = true;
        }
        usdc = new MockUSDC();
        dex = new MockDEX(usdc, deployer);
        vault = new Vault(deployer, address(dex), pyth);
        for (uint256 i = 0; i < specs.length; i++) {
            MockAssetToken token = new MockAssetToken(specs[i].name, specs[i].symbol, 18, address(dex));
            dex.listAsset(token);
            tokens[specs[i].key] = token;
            vault.setAssetProfile(
                assetId(specs[i].key), assetProfile(profiles, specs[i].key, address(token), demoWaits)
            );
        }
        string[] memory handles = watchedHandles(watchlist);
        for (uint256 i = 0; i < handles.length; i++) {
            vault.setWatchableAccount(accountId(handles[i]), true);
        }
        vm.stopBroadcast();

        writeDeployment(deployer, specs);
    }

    /// @notice The limits from the asset profile: a rule may be stricter, never looser
    function assetProfile(string memory profiles, string memory key, address token, bool demoWaits)
        public
        pure
        returns (IVault.AssetProfile memory profile)
    {
        string memory asset = string.concat(".assets.", key);
        profile.token = token;
        profile.priceId = vm.parseJsonBytes32(profiles, string.concat(asset, ".pyth.priceId"));
        profile.minThresholdBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".trendThresholdBps")));
        profile.maxSpikeCapBps = uint16(vm.parseJsonUint(profiles, string.concat(asset, ".spikeCapBps")));
        profile.minWait = uint32(
            demoWaits
                ? vm.parseJsonUint(profiles, ".demoOverrides.minWaitSec")
                : vm.parseJsonUint(profiles, string.concat(asset, ".minWaitSec"))
        );
        profile.maxWindow = uint32(vm.parseJsonUint(profiles, string.concat(asset, ".maxWindowSec")));
        profile.maxPriceAge = uint32(vm.parseJsonUint(profiles, ".maxPriceAgeSec"));
        profile.maxConfBps = uint16(vm.parseJsonUint(profiles, ".maxConfBps"));
        profile.maxStopLossBps = uint16(vm.parseJsonUint(profiles, ".maxStopLossBps"));
    }

    function writeDeployment(address deployer, AssetSpec[] memory specs) internal {
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
        vm.serializeAddress("deployment", "pyth", pyth);
        vm.serializeBool("deployment", "localPyth", isLocalPyth);
        vm.serializeString("deployment", "assetIds", idsJson);
        string memory json = vm.serializeString("deployment", "assets", tokensJson);
        string memory defaultFile = string.concat("../shared/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, vm.envOr("DEPLOYMENT_FILE", defaultFile));
    }
}
