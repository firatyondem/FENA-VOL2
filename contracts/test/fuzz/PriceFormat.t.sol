// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProjectedJson} from "../../src/lib/ProjectedJson.sol";
import {PriceFormat} from "./PriceFormat.sol";

/// @notice The suite's price helper writes every uint256 price so that the vault's JSON reader reads it back unchanged
contract PriceFormatTest is Test {
    function test_FormatsPricesAsTheSignedJsonWritesThem() public pure {
        assertEq(PriceFormat.format(0), "0");
        assertEq(PriceFormat.format(1), "0.000000000000000001");
        assertEq(PriceFormat.format(2000e18), "2000");
        assertEq(PriceFormat.format(2000.5e18), "2000.5");
        assertEq(PriceFormat.format(2244.695e18), "2244.695");
        assertEq(PriceFormat.format(0.075845e18), "0.075845");
        assertEq(PriceFormat.format(0.05e18), "0.05");
        assertEq(PriceFormat.format(1e30), "1000000000000");
        assertEq(PriceFormat.format(10.000000000000000001e18), "10.000000000000000001");
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_FormatRoundTripsThroughProjectedJson(uint256 price) public pure {
        bytes memory data = bytes(string.concat('{"price":', PriceFormat.format(price), ',"updatedAt":1793381072608}'));
        assertEq(ProjectedJson.readUint(data, "price", 18), price);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_FormatWritesNoTrailingZerosAfterThePoint(uint256 price) public pure {
        bytes memory text = bytes(PriceFormat.format(price));
        bool hasPoint;
        for (uint256 i; i < text.length; i++) {
            if (text[i] == ".") hasPoint = true;
        }
        if (hasPoint) assertTrue(text[text.length - 1] != "0", "trailing zero");
        assertTrue(text.length > 0 && text[0] != ".", "starts with a digit");
    }
}
