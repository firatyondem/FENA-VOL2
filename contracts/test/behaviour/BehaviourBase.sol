// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {Vault} from "../../src/vault/Vault.sol";
import {RealMocksBase} from "../utils/RealMocksBase.sol";
import {Reenterer} from "./mocks/Reenterer.sol";

/// @notice A hostile mock that the test can make call any contract, such as Reenterer
interface IExecutor {
    function execute(address to, bytes calldata data) external returns (bytes memory result);
}

/// @notice Helpers of the behaviour suite: a vault on a hostile DEX, a snapshot of the books, and the signed fixtures
/// @dev The vault reads its DEX and quote token once, at construction, so each hostile setup gets its own vault.
/// deployVaultOn points the base's `vault` at it, so every RealMocksBase helper works on the new vault.
abstract contract BehaviourBase is RealMocksBase {
    /// @dev Everything a failed buy or sell must leave as it was
    struct Books {
        uint256 vaultQuote;
        uint256 vaultAsset;
        uint256 userBalance;
        uint256 spentToday;
        uint256 triggerCount;
        uint256 positionCount;
    }

    /// @dev Deploys a vault on `dex_` with the base's profiles and accounts, funds the user and sets the ETH rule
    function deployVaultOn(address dex_) internal {
        vault = new Vault(address(this), dex_, address(pyth));
        vault.setAssetProfile(ETH, ethProfile());
        vault.setAssetProfile(OIL, oilProfile());
        vault.setWatchableAccount(ACCOUNT, true);
        vault.setWatchableAccount(OTHER_ACCOUNT, true);
        fund(user, 1_000e6);
        vm.prank(user);
        setEthRule(ethRule());
    }

    /// @dev Deploys Person B's real MockDEX on the quote token `quote`, a tETH and a tOIL that this DEX mints, and a vault
    /// on it, then points the base's `usdc`, `dex`, `teth`, `toil` and `vault` at them. `quote` must let anyone mint, like
    /// MockUSDC, so that the DEX can pay out sells and fund() can mint.
    function deployMarketOn(address quote) internal {
        usdc = MockUSDC(quote);
        dex = new MockDEX(usdc, address(this));
        teth = new MockAssetToken("Test Ether", "tETH", 18, address(dex));
        toil = new MockAssetToken("Test Crude Oil", "tOIL", 18, address(dex));
        dex.listAsset(teth);
        dex.listAsset(toil);
        deployVaultOn(address(dex));
    }

    /// @dev Replaces the user's rule with ETH only, without a cooldown
    function setEthRuleWithoutCooldown() internal {
        vm.prank(user);
        setEthRule(ethRuleWithoutCooldown());
    }

    /// @dev Gives `who`, a contract that can execute calls for the test, a balance of `amount` in the vault, so that a
    /// call it makes back into the vault has something to take
    function fundContract(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        IExecutor(who).execute(address(usdc), abi.encodeCall(IERC20.approve, (address(vault), amount)));
        IExecutor(who).execute(address(vault), abi.encodeCall(IVault.deposit, (amount)));
    }

    /// @dev The ETH rule without a cooldown, so that a second buy in a row meets only the check under test
    function ethRuleWithoutCooldown() internal pure returns (IVault.AssetRule memory assetRule) {
        assetRule = ethRule();
        assetRule.cooldown = 0;
    }

    /// @dev Opens an ETH trigger at P0 = 2000 and returns a P1 of 2070 (+3.5%) signed 31 minutes later
    function openAndWait() internal returns (uint256 triggerId, bytes[] memory p1) {
        triggerId = openEthTrigger("2000");
        vm.warp(block.timestamp + 31 minutes);
        p1 = signedPrice("2070");
    }

    function reentrancyError() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    }

    /// @dev The hostile mock called back into the vault, the call failed with `expectedError`, and the mock went on
    function assertCallbackFailed(Reenterer reenterer, bytes memory expectedError) internal view {
        assertTrue(reenterer.attempted(), "callback attempted");
        assertFalse(reenterer.callSucceeded(), "callback succeeded");
        assertEq(reenterer.returnData(), expectedError, "callback error");
    }

    function books() internal view returns (Books memory) {
        return Books({
            vaultQuote: usdc.balanceOf(address(vault)),
            vaultAsset: teth.balanceOf(address(vault)),
            userBalance: vault.balanceOf(user),
            spentToday: vault.spentToday(user, ETH),
            triggerCount: vault.triggerCount(),
            positionCount: vault.positionCount()
        });
    }

    function assertBooks(Books memory actual, Books memory expected) internal pure {
        assertEq(actual.vaultQuote, expected.vaultQuote, "quote tokens in the vault");
        assertEq(actual.vaultAsset, expected.vaultAsset, "asset tokens in the vault");
        assertEq(actual.userBalance, expected.userBalance, "user's balance");
        assertEq(actual.spentToday, expected.spentToday, "spent today");
        assertEq(actual.triggerCount, expected.triggerCount, "trigger count");
        assertEq(actual.positionCount, expected.positionCount, "position count");
    }

    function assertTriggerStatus(uint256 triggerId, IVault.TriggerStatus status) internal view {
        assertEq(uint256(vault.getTrigger(triggerId).status), uint256(status), "trigger status");
    }

    function assertPositionOpen(uint256 positionId, bool isOpen) internal view {
        assertEq(vault.getPosition(positionId).isOpen, isOpen, "position open");
    }
}
