// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../src/interfaces/IVault.sol";
import {BehaviourBase} from "./BehaviourBase.sol";
import {ShortchangingDEX} from "./mocks/ShortchangingDEX.sol";

/// @notice The check that spec 3.4 asks of the vault: a swap that delivers less than the DEX returned reverts
/// @dev The same signature as Vault.DexDeliveredLess, which Vault declares itself because IVault stays frozen. The
/// selector depends only on the signature, so the tests match the vault's error.
interface IDexOutputCheck {
    error DexDeliveredLess(uint256 promised, uint256 delivered);
}

/// @notice A DEX that returns the full output but delivers less: the vault must revert instead of booking the shortfall
/// as the user's loss
contract ShortchangingDexTest is BehaviourBase {
    // The DEX keeps 10% of every output
    uint16 constant SHORTFALL_BPS = 1_000;

    ShortchangingDEX shortchanging;

    function setUp() public override {
        super.setUp();
        shortchanging = new ShortchangingDEX(dex);
        deployVaultOn(address(shortchanging));
    }

    function test_RevertWhen_TheDexDeliversLessThanItReturnsOnABuy() public {
        shortchanging.setShortfall(SHORTFALL_BPS, 0);
        uint256 triggerId = openEthTrigger("2000");
        vm.warp(block.timestamp + 31 minutes);
        bytes[] memory p1 = signedPrice("2070");
        uint256 promised = dex.quoteBuy(address(teth), 50e6, 2070e18);
        uint256 delivered = promised - promised * SHORTFALL_BPS / 10_000;
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IDexOutputCheck.DexDeliveredLess.selector, promised, delivered));
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
    }

    function test_RevertWhen_TheDexDeliversLessThanItReturnsOnASell() public {
        uint256 positionId = buyEth();
        shortchanging.setShortfall(0, SHORTFALL_BPS);
        bytes[] memory price = signedPrice("2100");
        uint256 promised = dex.quoteSell(address(teth), vault.getPosition(positionId).amount, 2100e18);
        uint256 delivered = promised - promised * SHORTFALL_BPS / 10_000;
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IDexOutputCheck.DexDeliveredLess.selector, promised, delivered));
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
    }

    /// @dev Control case: an honest swap through the same DEX goes through, so the reverts above come from the shortfall
    function test_ConfirmTrigger_BuysThroughTheDexWithoutAShortfall() public {
        uint256 positionId = buyEth();

        assertEq(vault.getPosition(positionId).amount, dex.quoteBuy(address(teth), 50e6, 2070e18), "amount");
        assertEq(teth.balanceOf(address(vault)), vault.getPosition(positionId).amount, "asset tokens in the vault");
    }
}
