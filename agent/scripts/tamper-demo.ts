// The tamper test, for the stage and for judges. Without a wallet it asks the deployed vault's read-only checkPrice, so it
// spends nothing and needs no open trigger:
//   npm run tamper-demo                                      a fresh real response, then its four forgeries
//   npm run tamper-demo -- --response my.json --asset ETH    your own signed response
// With TRIGGER_ID and AGENT_PRIVATE_KEY it sends the forgeries to that open ETH trigger instead and prints the revert.
// Without RPC_URL or a deployment of CHAIN_ID it runs the forgeries against the SimVault bench.
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Address, createPublicClient, createWalletClient, type Hex, http, isAddress, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { fetchSignedResponse } from '../src/airnode/client.ts';
import { formatFixedPoint } from '../src/airnode/projected-json.ts';
import { VaultRejection } from '../src/chain/vault.ts';
import { checkPrice, ViemVault } from '../src/chain/viem-vault.ts';
import { EventLog } from '../src/log.ts';
import { getAsset, loadProfiles, priceAirnode, priceRequest } from '../src/profiles.ts';
import { runTamperBench } from '../src/replay.ts';
import { buildTamperSet, fetchJudgeSet, readStaleEth } from './tamper-set.ts';

const { values } = parseArgs({ options: { response: { type: 'string' }, asset: { type: 'string', default: 'ETH' } } });

const profiles = loadProfiles();
const { TRIGGER_ID, RPC_URL, AGENT_PRIVATE_KEY } = process.env;
const chain = Number(process.env.CHAIN_ID || baseSepolia.id) === foundry.id ? foundry : baseSepolia;
const deploymentFile = new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url);
const vaultAddress =
  process.env.VAULT_ADDRESS ||
  (existsSync(deploymentFile) ? (JSON.parse(readFileSync(deploymentFile, 'utf8')) as { vault: Address }).vault : undefined);

const fetchPrice = (key: string) => {
  const asset = getAsset(profiles, key);
  return fetchSignedResponse(priceAirnode(profiles, asset).url, priceRequest(asset));
};

// What the vault's checkPrice says: its price and the time it read, or its refusal
const askVault = async (publicClient: PublicClient, address: Address, asset: string, response: SignedResponse) => {
  try {
    const { price, priceTime } = await checkPrice(publicClient, address, asset, response);
    const taken = new Date(Number(priceTime) * 1000).toISOString();
    return { actual: 'accepted', detail: `read ${asset} at ${formatFixedPoint(price, 18)}, taken ${taken}` };
  } catch (error) {
    if (error instanceof VaultRejection) return { actual: error.reason, detail: 'refused by the vault' };
    throw error;
  }
};

const readResponseFile = (path: string): SignedResponse => {
  const response = JSON.parse(readFileSync(path, 'utf8')) as Partial<SignedResponse>;
  const { requestHash, timestamp, data, signature } = response;
  if (typeof requestHash !== 'string' || timestamp === undefined || typeof data !== 'string' || typeof signature !== 'string') {
    throw new Error(`${path} needs requestHash, timestamp, data (the exact signed text) and signature`);
  }
  return response as SignedResponse;
};

if (!RPC_URL || !vaultAddress) {
  if (values.response) throw new Error(`--response needs RPC_URL and a vault: set VAULT_ADDRESS, or deploy to chain ${chain.id}`);
  console.log('No RPC_URL or deployed vault: running the forgeries against the SimVault bench.\n');
  const log = new EventLog();
  await runTamperBench(profiles, log);
  for (const event of log.recent()) {
    if (event.kind !== 'tamper.result') continue;
    console.log(`${event.passed ? 'REFUSED' : 'ACCEPTED'}  ${event.name.padEnd(18)} ${event.actual}`);
  }
} else if (!isAddress(vaultAddress)) {
  throw new Error('VAULT_ADDRESS is not an address');
} else if (TRIGGER_ID) {
  if (!AGENT_PRIVATE_KEY) throw new Error('Sending to a trigger needs AGENT_PRIVATE_KEY');
  const account = privateKeyToAccount(AGENT_PRIVATE_KEY as Hex);
  const vault = new ViemVault({
    address: vaultAddress,
    publicClient: createPublicClient({ chain, transport: http(RPC_URL) }) as never,
    walletClient: createWalletClient({ chain, transport: http(RPC_URL), account }),
    profiles,
    watchlist: [],
  });
  const cases = await buildTamperSet(await fetchPrice('ETH'), await fetchPrice('BTC'), readStaleEth());
  for (const tamper of cases) {
    let actual = 'ACCEPTED';
    try {
      await vault.confirmTrigger(TRIGGER_ID, tamper.response);
    } catch (error) {
      actual = error instanceof VaultRejection ? error.reason : (error as Error).message;
    }
    const verdict = actual === tamper.expected ? 'REFUSED' : actual === 'ACCEPTED' ? 'ACCEPTED' : 'REFUSED?';
    console.log(`${verdict.padEnd(9)} ${tamper.name.padEnd(18)} ${actual}  (${tamper.how})`);
  }
} else {
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) }) as PublicClient;
  console.log(`Asking the vault at ${vaultAddress} on ${chain.name}, read-only: no wallet, no gas, nothing moves.\n`);
  if (values.response) {
    const { actual, detail } = await askVault(publicClient, vaultAddress, values.asset, readResponseFile(values.response));
    console.log(`${actual === 'accepted' ? 'ACCEPTED' : 'REFUSED'}  ${actual === 'accepted' ? detail : actual}`);
  } else {
    let unexpected = 0;
    for (const tamper of await fetchJudgeSet(fetchPrice)) {
      const { actual, detail } = await askVault(publicClient, vaultAddress, 'ETH', tamper.response);
      const verdict = actual !== tamper.expected ? 'UNEXPECTED' : actual === 'accepted' ? 'ACCEPTED' : 'REFUSED';
      if (actual !== tamper.expected) unexpected++;
      console.log(`${verdict.padEnd(10)} ${tamper.name.padEnd(21)} ${actual === 'accepted' ? detail : actual}  (${tamper.how})`);
    }
    if (unexpected > 0) process.exitCode = 1;
  }
}
