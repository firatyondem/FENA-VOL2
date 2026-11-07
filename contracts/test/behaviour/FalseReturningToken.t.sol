// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVault} from "../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../src/mocks/MockAssetToken.sol";
import {MockDEX} from "../../src/mocks/MockDEX.sol";
import {BehaviourBase} from "./BehaviourBase.sol";
import {FalseReturningToken} from "./mocks/FalseReturningToken.sol";

/// @notice A quote token that answers false instead of reverting, as some older tokens do: the vault reverts with
/// SafeERC20FailedOperation, never credits a deposit it did not receive and never debits a withdrawal it did not pay
contract FalseReturningQuoteTokenTest is BehaviourBase {
    FalseReturningToken quote;

    function setUp() public override {
        super.setUp();
        // With a zero minter anyone can mint, like MockUSDC, so the real MockDEX can pay out sells with it.
        quote = new FalseReturningToken("False USD", "fUSD", 6, address(0));
        deployMarketOn(address(quote));
    }

    function failedOperation() internal view returns (bytes memory) {
        return abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(quote));
    }

    function test_RevertWhen_TheQuoteTokenAnswersFalseOnADeposit() public {
        usdc.mint(user, 10e6);
        quote.setFailures(false, true, false);
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(failedOperation());
        vault.deposit(10e6);

        assertBooks(books(), before);
        assertEq(usdc.balanceOf(user), 10e6, "the tokens stayed in the wallet");
    }

    function test_RevertWhen_TheQuoteTokenAnswersFalseOnAWithdraw() public {
        quote.setFailures(true, false, false);
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(failedOperation());
        vault.withdraw(100e6);

        assertBooks(books(), before);
        assertEq(usdc.balanceOf(user), 0, "nothing was paid");

        // Once the token is honest again, the same withdrawal pays.
        quote.setFailures(false, false, false);
        vm.prank(user);
        vault.withdraw(100e6);
        assertEq(usdc.balanceOf(user), 100e6, "paid on the retry");
        assertEq(vault.balanceOf(user), before.userBalance - 100e6);
    }

    function test_RevertWhen_TheQuoteTokenAnswersFalseOnTheApprovalOfABuy() public {
        (uint256 triggerId, bytes[] memory p1) = openAndWait();
        quote.setFailures(false, false, true);
        Books memory before = books();

        vm.prank(keeper);
        vm.expectRevert(failedOperation());
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);

        // The trigger stays open, so the same price buys once the token is honest again.
        quote.setFailures(false, false, false);
        vm.prank(keeper);
        uint256 positionId = vault.confirmTrigger(triggerId, p1);
        assertPositionOpen(positionId, true);
        assertEq(vault.balanceOf(user), before.userBalance - 50e6);
    }

    function test_RevertWhen_TheQuoteTokenAnswersFalseWhenTheDexPullsIt() public {
        (uint256 triggerId, bytes[] memory p1) = openAndWait();
        quote.setFailures(false, true, false);
        Books memory before = books();

        // The real MockDEX checks the answer of transferFrom, and the vault passes its revert on.
        vm.prank(keeper);
        vm.expectRevert(MockDEX.TransferFailed.selector);
        vault.confirmTrigger(triggerId, p1);

        assertBooks(books(), before);
        assertTriggerStatus(triggerId, IVault.TriggerStatus.Open);
        assertEq(usdc.allowance(address(vault), address(dex)), 0, "allowance left to the DEX");
    }
}

/// @notice An asset token that answers false instead of reverting, bought on the real MockDEX: a sell that cannot move
/// the token reverts, the position stays open, and the vault keeps every asset token
contract FalseReturningAssetTokenTest is BehaviourBase {
    FalseReturningToken asset;

    function setUp() public override {
        super.setUp();
        // The token has the DEX as its minter, so the real MockDEX lists it and mints it on a buy.
        asset = new FalseReturningToken("False Ether", "fETH", 18, address(dex));
        dex.listAsset(MockAssetToken(address(asset)));
        IVault.AssetProfile memory profile = ethProfile();
        profile.token = address(asset);
        vault.setAssetProfile(ETH, profile);
    }

    function test_RevertWhen_TheAssetTokenAnswersFalseOnTheApprovalOfASell() public {
        uint256 positionId = buyEth();
        uint256 amount = vault.getPosition(positionId).amount;
        assertEq(asset.balanceOf(address(vault)), amount, "the vault holds what it bought");
        asset.setFailures(false, false, true);
        vm.warp(block.timestamp + 10 minutes);
        bytes[] memory price = signedPrice("2100");
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(asset)));
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
        assertEq(asset.balanceOf(address(vault)), amount, "the asset tokens stay in the vault");

        // Once the token is honest again, the position sells at the same price.
        asset.setFailures(false, false, false);
        vm.prank(user);
        uint256 quoteOut = vault.sell(positionId, IVault.SellReason.Manual, price);
        assertEq(quoteOut, dex.quoteSell(address(asset), amount, 2100e18), "proceeds");
        assertPositionOpen(positionId, false);
        assertEq(asset.balanceOf(address(vault)), 0, "no asset tokens left");
    }

    function test_RevertWhen_TheAssetTokenAnswersFalseWhenTheDexPullsIt() public {
        uint256 positionId = buyEth();
        uint256 amount = vault.getPosition(positionId).amount;
        asset.setFailures(false, true, false);
        vm.warp(block.timestamp + 10 minutes);
        bytes[] memory price = signedPrice("2100");
        Books memory before = books();

        vm.prank(user);
        vm.expectRevert(MockDEX.TransferFailed.selector);
        vault.sell(positionId, IVault.SellReason.Manual, price);

        assertBooks(books(), before);
        assertPositionOpen(positionId, true);
        assertEq(asset.balanceOf(address(vault)), amount, "the asset tokens stay in the vault");
        assertEq(asset.allowance(address(vault), address(dex)), 0, "allowance left to the DEX");
    }
}
