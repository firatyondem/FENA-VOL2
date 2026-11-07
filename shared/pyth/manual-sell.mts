// For Person B: a manual sell from the website, with no agent console in the loop. Only the position's owner can sell
// by hand, at any fresh Pyth price (at most 5 minutes old; a closed market has none, so a stock waits for the open).
//
// 1. Get a Pyth update. Hermes needs an API key since 2026-08-26 and the key must not ship to a browser, so the website
//    asks the agent, which adds the key server-side: GET <agent>/api/price-update?asset=ETH
//    -> { asset, updates: ["0x504e4155..."], fee: "30", prices: [...] }
//    A server of your own with a key can call Hermes directly instead (fetchFromHermes below).
// 2. Ask the vault for the fee (vault.updateFee(updates)), which is what Pyth charges: 10 wei per price on Base Sepolia.
// 3. Call vault.sell(positionId, 0 /* Manual */, updates) with the fee as the value. Anything above it comes back.
//
// Works with viem; with ethers v6 it is `vault.sell(id, 0, updates, { value: await vault.updateFee(updates) })`.
import type { Abi, Address, Hex, PublicClient, WalletClient } from 'viem';

// IVault.SellReason
export const SELL_REASON = { manual: 0, takeProfit: 1, stagnation: 2, stopLoss: 3 } as const;

// The two vault functions a manual sell needs, from shared/deployments/abi/Vault.json
export const manualSellAbi = [
  {
    type: 'function',
    name: 'updateFee',
    stateMutability: 'view',
    inputs: [{ name: 'priceUpdate', type: 'bytes[]' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sell',
    stateMutability: 'payable',
    inputs: [
      { name: 'positionId', type: 'uint256' },
      { name: 'reason', type: 'uint8' },
      { name: 'priceUpdate', type: 'bytes[]' },
    ],
    outputs: [{ name: 'quoteOut', type: 'uint256' }],
  },
] as const satisfies Abi;

// Step 1 from the browser: the agent's update for an asset key such as "ETH"
export const fetchFromAgent = async (agentUrl: string, asset: string): Promise<Hex[]> => {
  const response = await fetch(`${agentUrl.replace(/\/$/, '')}/api/price-update?asset=${encodeURIComponent(asset)}`);
  if (!response.ok) throw new Error(`The agent has no price for ${asset}: ${response.status}`);
  return ((await response.json()) as { updates: Hex[] }).updates;
};

// Step 1 from a server with a Pyth API key: the feed ID is in shared/asset-profiles.json (assets.<key>.pyth.priceId)
export const fetchFromHermes = async (feedId: Hex, apiKey: string, hermes = 'https://hermes.pyth.network'): Promise<Hex[]> => {
  const response = await fetch(`${hermes}/v2/updates/price/latest?ids%5B%5D=${feedId.slice(2)}&encoding=hex`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`Hermes answered ${response.status}`);
  return ((await response.json()) as { binary: { data: string[] } }).binary.data.map((hex) => `0x${hex}` as Hex);
};

// Steps 2 and 3: the owner's wallet sells the position at the update's price and pays Pyth's fee
export const manualSell = async (
  publicClient: PublicClient,
  ownerWallet: WalletClient,
  vault: Address,
  positionId: bigint,
  updates: Hex[]
) => {
  const fee = await publicClient.readContract({ address: vault, abi: manualSellAbi, functionName: 'updateFee', args: [updates] });
  const account = ownerWallet.account;
  if (!account) throw new Error('The wallet has no account');
  // The simulation names the vault's refusal (NotPositionOwner, PriceTooOld, ...) before any gas is spent
  const { request } = await publicClient.simulateContract({
    address: vault,
    abi: manualSellAbi,
    functionName: 'sell',
    args: [positionId, SELL_REASON.manual, updates],
    value: fee,
    account,
  });
  return ownerWallet.writeContract(request);
};
