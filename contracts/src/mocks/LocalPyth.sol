// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @notice The parts of Pyth that the vault calls, without signatures, for tests and a local chain: an update is
/// abi.encode(PythStructs.PriceFeed, uint64 prevPublishTime), as in the SDK's MockPyth. Anyone can write any price, so
/// never point a vault on a public chain at it.
/// @dev Adapted from @pythnetwork/pyth-sdk-solidity's MockPyth (Apache-2.0), whose parsePriceFeedUpdatesUnique does not
/// check uniqueness. This one does, as the real contract does: the price must be the first after minPublishTime, so
/// prevPublishTime < minPublishTime. Real signatures are tested on a fork of Base Sepolia with real Hermes payloads.
contract LocalPyth {
    uint256 public singleUpdateFeeInWei;

    constructor(uint256 singleUpdateFeeInWei_) {
        singleUpdateFeeInWei = singleUpdateFeeInWei_;
    }

    function setFee(uint256 fee) external {
        singleUpdateFeeInWei = fee;
    }

    function getUpdateFee(bytes[] calldata updateData) public view returns (uint256) {
        return singleUpdateFeeInWei * updateData.length;
    }

    function parsePriceFeedUpdates(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        return _parse(updateData, priceIds, minPublishTime, maxPublishTime, false);
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        return _parse(updateData, priceIds, minPublishTime, maxPublishTime, true);
    }

    function _parse(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime,
        bool unique
    ) private returns (PythStructs.PriceFeed[] memory feeds) {
        if (msg.value < getUpdateFee(updateData)) revert PythErrors.InsufficientFee();
        feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint256 i; i < priceIds.length; i++) {
            bool found;
            for (uint256 j; j < updateData.length; j++) {
                (PythStructs.PriceFeed memory feed, uint64 prevPublishTime) =
                    abi.decode(updateData[j], (PythStructs.PriceFeed, uint64));
                uint256 publishTime = feed.price.publishTime;
                if (
                    feed.id == priceIds[i] && minPublishTime <= publishTime && publishTime <= maxPublishTime
                        && (!unique || prevPublishTime < minPublishTime)
                ) {
                    feeds[i] = feed;
                    found = true;
                    break;
                }
            }
            if (!found) revert PythErrors.PriceFeedNotFoundWithinRange();
        }
    }
}
