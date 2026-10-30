// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Writes an 18-decimal price as the decimal number that a signed price JSON holds
/// @notice Nodary writes a price such as {"price":2244.695,...}: digits, at most one point, no exponent and no trailing
/// zeros after the point. format(2244.695e18) returns "2244.695", so a fuzz test can sign any uint256 price and the
/// vault reads back exactly that value with ProjectedJson.readUint(data, "price", 18).
library PriceFormat {
    uint256 internal constant DECIMALS = 18;
    uint256 internal constant UNIT = 1e18;

    /// @notice Writes `price`, a number with 18 decimals, such as 2000.5e18 as "2000.5", 2000e18 as "2000" and 1 as
    /// "0.000000000000000001"
    function format(uint256 price) internal pure returns (string memory) {
        uint256 whole = price / UNIT;
        uint256 fraction = price % UNIT;
        if (fraction == 0) return Strings.toString(whole);

        // Drops the trailing zeros of the fraction and counts the digits that are left.
        uint256 fractionDigits = DECIMALS;
        while (fraction % 10 == 0) {
            fraction /= 10;
            fractionDigits--;
        }
        bytes memory fractionText = bytes(Strings.toString(fraction));
        // The fraction keeps its leading zeros, so 0.05 stays "0.05" instead of becoming "0.5".
        bytes memory leadingZeros = new bytes(fractionDigits - fractionText.length);
        for (uint256 i; i < leadingZeros.length; i++) {
            leadingZeros[i] = "0";
        }
        return string.concat(Strings.toString(whole), ".", string(leadingZeros), string(fractionText));
    }
}
