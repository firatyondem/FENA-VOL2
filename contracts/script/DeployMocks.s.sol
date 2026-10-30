// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAssetToken} from "../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../src/mocks/MockDEX.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice The Foundry cheatcodes this script uses
interface ScriptCheatCodes {
    function envUint(string calldata name) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function addr(uint256 privateKey) external pure returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function projectRoot() external view returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory);
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory);
    function writeJson(string calldata json, string calldata path) external;
}

/// @title Deploys mock USDC, the mock DEX and the mock asset tokens
/// @notice Run against Base Sepolia, or a local anvil, with PRIVATE_KEY set:
///   forge script contracts/script/DeployMocks.s.sol --rpc-url $RPC_URL --broadcast
/// Writes the addresses to shared/deployments/<chain id>.json for the agent and the vault deploy. Set VAULT_ADDRESS to
/// approve an already deployed vault as the DEX trader; otherwise the vault deploy does that.
contract DeployMocks {
    ScriptCheatCodes internal constant vm = ScriptCheatCodes(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct AssetSpec {
        string key;
        string name;
        string symbol;
    }

    MockUSDC public usdc;
    MockDEX public dex;
    mapping(string key => MockAssetToken) public assets;

    function assetSpecs() public pure returns (AssetSpec[] memory specs) {
        specs = new AssetSpec[](5);
        specs[0] = AssetSpec("OIL", "Test Crude Oil", "tOIL");
        specs[1] = AssetSpec("DOGE", "Test Dogecoin", "tDOGE");
        specs[2] = AssetSpec("ETH", "Test Ether", "tETH");
        specs[3] = AssetSpec("BTC", "Test Bitcoin", "tBTC");
        specs[4] = AssetSpec("TSLA", "Test Tesla", "tTSLA");
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address vault = vm.envOr("VAULT_ADDRESS", address(0));
        AssetSpec[] memory specs = assetSpecs();

        vm.startBroadcast(deployerKey);
        usdc = new MockUSDC();
        dex = new MockDEX(usdc, deployer);
        for (uint256 i = 0; i < specs.length; i++) {
            MockAssetToken token = new MockAssetToken(specs[i].name, specs[i].symbol, 18, address(dex));
            dex.listAsset(token);
            assets[specs[i].key] = token;
        }
        if (vault != address(0)) dex.setTrader(vault, true);
        vm.stopBroadcast();

        writeDeployment(deployer, vault, specs);
    }

    function writeDeployment(address deployer, address vault, AssetSpec[] memory specs) internal {
        string memory assetsJson;
        for (uint256 i = 0; i < specs.length; i++) {
            assetsJson = vm.serializeAddress("assets", specs[i].key, address(assets[specs[i].key]));
        }
        vm.serializeUint("deployment", "chainId", block.chainid);
        vm.serializeUint("deployment", "deployedAtBlock", block.number);
        vm.serializeAddress("deployment", "deployer", deployer);
        vm.serializeAddress("deployment", "usdc", address(usdc));
        vm.serializeAddress("deployment", "dex", address(dex));
        vm.serializeAddress("deployment", "dexTrader", vault);
        string memory json = vm.serializeString("deployment", "assets", assetsJson);
        string memory path =
            string.concat(vm.projectRoot(), "/shared/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
