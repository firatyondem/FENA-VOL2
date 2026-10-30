// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Calls back into a target once, at a chosen point of a hostile mock, and records what happened
/// @dev The test arms it with the selector of the function in which to call back. With `bubble`, a failed callback
/// reverts the outer call with the same data; without it, the outcome is only recorded, so the test can show that the
/// callback had no effect while the outer call went through.
abstract contract Reenterer {
    address public immutable controller;

    bytes4 public hookPoint;
    address public target;
    bytes public payload;
    bool public bubble;

    bool public attempted;
    bool public callSucceeded;
    bytes public returnData;

    error NotController(address caller);

    constructor() {
        controller = msg.sender;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController(msg.sender);
        _;
    }

    /// @notice Calls `target` with `payload` the next time the mock reaches `hookPoint`
    function arm(bytes4 hookPoint_, address target_, bytes calldata payload_, bool bubble_) external onlyController {
        hookPoint = hookPoint_;
        target = target_;
        payload = payload_;
        bubble = bubble_;
    }

    /// @notice Makes this contract call `to`, so it can hold a balance in the vault like any other user
    function execute(address to, bytes calldata data) external onlyController returns (bytes memory result) {
        bool success;
        (success, result) = to.call(data);
        if (!success) _revertWith(result);
    }

    function _reenter(bytes4 point) internal {
        if (hookPoint == bytes4(0) || point != hookPoint) return;
        hookPoint = bytes4(0);
        attempted = true;
        (bool success, bytes memory data) = target.call(payload);
        callSucceeded = success;
        returnData = data;
        if (!success && bubble) _revertWith(data);
    }

    function _revertWith(bytes memory data) private pure {
        assembly ("memory-safe") {
            revert(add(data, 32), mload(data))
        }
    }
}
