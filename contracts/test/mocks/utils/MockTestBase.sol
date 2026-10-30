// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The few Foundry cheatcodes the mock tests use
interface CheatCodes {
    function prank(address sender) external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
    function assume(bool condition) external pure;
    function addr(uint256 privateKey) external pure returns (address);
}

/// @title Base for the mock contract tests
/// @dev Keeps the mock tests free of dependencies; forge runs any public test* function, and a revert fails it. Once
/// forge-std is in lib/, these tests can inherit forge-std's Test instead without other changes.
abstract contract MockTestBase {
    CheatCodes internal constant vm = CheatCodes(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed(string what, uint256 actual, uint256 expected);
    error AssertionFailedAddress(string what, address actual, address expected);
    error AssertionFailedBool(string what);

    function assertEq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailed(what, actual, expected);
    }

    function assertEq(address actual, address expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailedAddress(what, actual, expected);
    }

    function assertTrue(bool condition, string memory what) internal pure {
        if (!condition) revert AssertionFailedBool(what);
    }

    function assertLe(uint256 actual, uint256 max, string memory what) internal pure {
        if (actual > max) revert AssertionFailed(what, actual, max);
    }

    function assertGe(uint256 actual, uint256 min, string memory what) internal pure {
        if (actual < min) revert AssertionFailed(what, actual, min);
    }

    /// @dev Maps a fuzzed value into [min, max] without rejecting runs
    function bound(uint256 value, uint256 min, uint256 max) internal pure returns (uint256) {
        return min + (value % (max - min + 1));
    }
}
