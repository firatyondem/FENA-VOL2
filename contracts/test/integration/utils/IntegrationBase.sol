// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../../../src/interfaces/IVault.sol";
import {MockAssetToken} from "../../../src/mocks/MockAssetToken.sol";
import {RealMocksBase} from "../../utils/RealMocksBase.sol";

/// @notice Shared setup of the integration suite: the real MockDEX with a third asset (tBTC), the independent swap
/// arithmetic, and a check that the vault's books balance against the tokens it holds
abstract contract IntegrationBase is RealMocksBase {
    bytes32 internal constant BTC = keccak256("BTC");
    uint256 internal constant BPS = 10_000;

    MockAssetToken internal tbtc;

    /// @dev Every account that may hold a balance in the vault, so the books can be added up
    address[] internal holders;

    function setUp() public virtual override {
        super.setUp();
        tbtc = new MockAssetToken("Test Bitcoin", "tBTC", 18, address(dex));
        dex.listAsset(tbtc);
        // RealMocksBase funds `user` with 1,000 USDC.
        holders.push(user);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Accounts
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Mints `amount` mock USDC to `who` and deposits it, and checks the Deposited event and both balances
    function deposit(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        uint256 walletBefore = usdc.balanceOf(who);
        uint256 balanceBefore = vault.balanceOf(who);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vm.expectEmit(address(vault));
        emit IVault.Deposited(who, amount);
        vault.deposit(amount);
        vm.stopPrank();
        assertEq(usdc.balanceOf(who), walletBefore - amount, "wallet after deposit");
        assertEq(vault.balanceOf(who), balanceBefore + amount, "vault balance after deposit");
        addHolder(who);
    }

    function addHolder(address who) internal {
        for (uint256 i; i < holders.length; i++) {
            if (holders[i] == who) return;
        }
        holders.push(who);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Swap arithmetic, worked out without the DEX
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Asset tokens (18 decimals) that `quoteIn` mock USDC (6 decimals) buys at `price` (18 decimals), rounded
    /// down
    function assetOutAt(uint256 quoteIn, uint256 price) internal pure returns (uint256) {
        return quoteIn * 1e18 * 1e18 / (price * 1e6);
    }

    /// @dev Mock USDC that `assetIn` asset tokens sell for at `price`, rounded down
    function quoteOutAt(uint256 assetIn, uint256 price) internal pure returns (uint256) {
        return assetIn * price * 1e6 / (1e18 * 1e18);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Books
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The vault's mock USDC equals the sum of the free balances, and for each asset token the vault's balance and
    /// the token's total supply equal the sum of the open positions in it. The DEX burns what it buys back, so no one
    /// else holds asset tokens.
    function assertBooksBalance() internal view {
        uint256 freeBalances;
        for (uint256 i; i < holders.length; i++) {
            freeBalances += vault.balanceOf(holders[i]);
        }
        assertEq(usdc.balanceOf(address(vault)), freeBalances, "vault USDC != sum of free balances");

        MockAssetToken[3] memory tokens = [teth, toil, tbtc];
        for (uint256 t; t < tokens.length; t++) {
            uint256 open;
            for (uint256 id = 1; id <= vault.positionCount(); id++) {
                IVault.Position memory position = vault.getPosition(id);
                if (position.isOpen && vault.getAssetProfile(position.assetId).token == address(tokens[t])) {
                    open += position.amount;
                }
            }
            assertEq(tokens[t].balanceOf(address(vault)), open, "vault asset tokens != open positions");
            assertEq(tokens[t].totalSupply(), open, "asset token supply != open positions");
        }
    }

    function responseHash(IVault.SignedResponse memory response) internal pure returns (bytes32) {
        return keccak256(abi.encode(response.requestHash, response.timestamp, response.data));
    }
}
