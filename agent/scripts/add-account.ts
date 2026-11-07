// Registers one watched account on the deployed vault, from the owner's wallet, so a new account needs no new deploy. The
// vault knows an account by keccak256 of its lower-case handle. Add the handle to config/watchlist.json too, so the agent
// polls it; users still pick it in their rule.
//   OWNER_PRIVATE_KEY=0x... npm run add-account -- fenahackdemo
import { readFileSync } from 'node:fs';
import { type Address, createPublicClient, createWalletClient, type Hex, http, isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { vaultAbi } from '../src/chain/vault-abi.ts';
import { accountIdOf } from '../src/sources/posts.ts';

const readJson = <T>(url: URL): T => JSON.parse(readFileSync(url, 'utf8')) as T;

const handle = process.argv[2];
const { RPC_URL, OWNER_PRIVATE_KEY } = process.env;
if (!handle) throw new Error('Name the account: npm run add-account -- <handle>');
if (!RPC_URL || !OWNER_PRIVATE_KEY) throw new Error('Set RPC_URL and OWNER_PRIVATE_KEY');

const chain = Number(process.env.CHAIN_ID || baseSepolia.id) === foundry.id ? foundry : baseSepolia;
const { vault } = readJson<{ vault: Address }>(new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url));
const accountId = accountIdOf(handle);

const account = privateKeyToAccount(OWNER_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ chain, transport: http(RPC_URL), account });
const isRegistered = () =>
  publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'isWatchableAccount', args: [accountId] });

const owner = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'owner' });
if (!isAddressEqual(owner, account.address)) throw new Error(`The vault's owner is ${owner}, not this key's ${account.address}`);

if (await isRegistered()) {
  console.log(`@${handle} is already registered on ${vault}`);
} else {
  const { request } = await publicClient.simulateContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'setWatchableAccount',
    args: [accountId, true],
    account,
  });
  const hash = await walletClient.writeContract(request);
  const { status } = await publicClient.waitForTransactionReceipt({ hash });
  if (status !== 'success') throw new Error(`The transaction ${hash} reverted`);
  if (!(await isRegistered())) throw new Error(`The vault still does not list @${handle}`);
  console.log(`Registered @${handle} on ${vault} on ${chain.name}: ${hash}`);
}
