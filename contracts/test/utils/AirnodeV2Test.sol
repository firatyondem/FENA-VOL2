// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Test} from "forge-std/Test.sol";

abstract contract AirnodeV2Test is Test {
    /// @notice Signs a response the way an Airnode v2 does, so a test can make up responses or sign them with the wrong
    /// key
    function signResponse(uint256 privateKey, bytes32 requestHash, uint256 timestamp, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encodePacked(requestHash, timestamp, data));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }
}
