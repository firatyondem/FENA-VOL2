// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {FixtureBase} from "./FixtureBase.sol";

/// @notice checkPrice runs the checks of every P1 and sell price for anyone, records nothing, and moves nothing
contract CheckPriceTest is FixtureBase {
    function setUp() public override {
        super.setUp();
        vm.warp(CONFIRM_AT);
    }

    function test_ReadsThePriceAndItsPublishTime() public {
        (uint256 price, uint256 publishTime) = vault.checkPrice(ETH, fixture("eth-p1-rise"));
        assertEq(price, 2070e18);
        assertEq(publishTime, T1);
    }

    function test_AnyoneMayCheck() public {
        vm.prank(makeAddr("anyone"));
        (uint256 price,) = vault.checkPrice(ETH, fixture("eth-p1-rise"));
        assertEq(price, 2070e18);
    }

    function test_MovesNothingAndLeavesThePriceUnused() public {
        uint256 triggerId = openWith(user, agent, ETH, fixtureTweet("tweet-trump-venezuela"), fixture("eth-p0"));
        Books memory before = books();

        vault.checkPrice(ETH, fixture("eth-p1-rise"));

        assertBooks(books(), before);
        // The checked price still confirms the trigger.
        vault.confirmTrigger(triggerId, fixture("eth-p1-rise"));
    }

    function test_RevertWhen_AValueIsEdited() public {
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.checkPrice(ETH, fixture("tamper-edited-value"));
    }

    function test_RevertWhen_ThePriceIsStale() public {
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, STALE_TIME));
        vault.checkPrice(ETH, fixture("tamper-stale"));
    }

    function test_RevertWhen_TheUpdateIsForAnotherAsset() public {
        vm.expectRevert(abi.encodeWithSelector(IVault.WrongPriceFeed.selector, ETH_FEED));
        vault.checkPrice(ETH, fixture("tamper-different-request"));
    }

    function test_RevertWhen_SomeoneElseSigned() public {
        vm.expectRevert(IVault.InvalidPriceUpdate.selector);
        vault.checkPrice(ETH, fixture("tamper-wrong-signer"));
    }

    function test_RevertWhen_ThePriceIsOlderThanTheProfileAllows() public {
        vm.warp(T1 + 5 minutes + 1);
        vm.expectRevert(abi.encodeWithSelector(IVault.PriceTooOld.selector, T1));
        vault.checkPrice(ETH, fixture("eth-p1-rise"));
    }

    function test_RevertWhen_TheAssetIsNotRegistered() public {
        bytes32 doge = keccak256("DOGE");
        vm.expectRevert(abi.encodeWithSelector(IVault.AssetNotRegistered.selector, doge));
        vault.checkPrice(doge, fixture("eth-p1-rise"));
    }
}
