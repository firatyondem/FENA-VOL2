// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {RealMocksBase} from "../utils/RealMocksBase.sol";

/// @notice Helpers of the unit suite on top of the real MockDEX and mock tokens
/// @dev Prices are written as decimal strings with 18 decimals, so "one unit" of a price is 1 wei.
abstract contract UnitBase is RealMocksBase {
    /// @dev Writes a number with 18 decimals as a decimal string, so 2059999999999999999999 reads
    /// "2059.999999999999999999"
    function decimalString(uint256 value) internal pure returns (string memory) {
        string memory fraction = vm.toString(value % 1e18);
        while (bytes(fraction).length < 18) {
            fraction = string.concat("0", fraction);
        }
        return string.concat(vm.toString(value / 1e18), ".", fraction);
    }

    /// @dev Replaces the user's rule with `rule_` and ETH as the only asset
    function setUserEthRule(IVault.Rule memory rule_, IVault.AssetRule memory assetRule) internal {
        vm.prank(user);
        vault.setRule(rule_, one(ETH), oneRule(assetRule), topics(1), watched());
    }

    /// @dev Opens an ETH trigger for the user as the agent
    function openWith(Post memory tweet, bytes[] memory p0) internal returns (uint256 triggerId) {
        vm.prank(agent);
        triggerId = openTriggerWith(user, ETH, tweet, p0);
    }

    /// @dev Opens an ETH trigger for a post one minute before P0, and returns t0, the time P0 was taken
    function openEthTriggerNow(string memory p0) internal returns (uint256 triggerId, uint256 t0) {
        triggerId = openEthTrigger(p0);
        t0 = block.timestamp;
    }

    /// @dev Warps to `t1` and confirms the trigger with a P1 published then
    function confirmAt(uint256 triggerId, uint256 t1, string memory p1) internal returns (uint256 positionId) {
        vm.warp(t1);
        bytes[] memory response = signedPrice(p1);
        positionId = vault.confirmTrigger(triggerId, response);
    }

    /// @dev Opens an ETH trigger at `p0` and buys at `p1` 31 minutes later
    function buyEthAt(string memory p0, string memory p1) internal returns (uint256 positionId) {
        (uint256 triggerId, uint256 t0) = openEthTriggerNow(p0);
        positionId = confirmAt(triggerId, t0 + 31 minutes, p1);
    }

    function statusOf(uint256 triggerId) internal view returns (IVault.TriggerStatus) {
        return vault.getTrigger(triggerId).status;
    }

    function assertStatus(uint256 triggerId, IVault.TriggerStatus expected) internal view {
        assertEq(uint256(statusOf(triggerId)), uint256(expected));
    }
}
