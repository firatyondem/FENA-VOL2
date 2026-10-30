// The on-stage tamper demo. With VAULT_ADDRESS and TRIGGER_ID set, it sends each forgery to that open ETH trigger on
// the deployed vault and prints the revert; without them it runs the same forgeries against the SimVault bench.
// Run with `npm run tamper-demo`.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, type Hex, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { type SignedResponse } from '../src/airnode/attestation.ts';
import { fetchSignedResponse } from '../src/airnode/client.ts';
import { VaultRejection } from '../src/chain/vault.ts';
import { ViemVault } from '../src/chain/viem-vault.ts';
import { EventLog } from '../src/log.ts';
import { getAsset, loadProfiles, priceAirnode, priceRequest } from '../src/profiles.ts';
import { runTamperBench } from '../src/replay.ts';
import { buildTamperSet } from './tamper-set.ts';

const profiles = loadProfiles();
const { VAULT_ADDRESS, TRIGGER_ID, RPC_URL, AGENT_PRIVATE_KEY } = process.env;

if (!VAULT_ADDRESS || !TRIGGER_ID) {
  console.log('No VAULT_ADDRESS and TRIGGER_ID: running the forgeries against the SimVault bench.\n');
  const log = new EventLog();
  await runTamperBench(profiles, log);
  for (const event of log.recent()) {
    if (event.kind !== 'tamper.result') continue;
    console.log(`${event.passed ? 'REFUSED' : 'ACCEPTED'}  ${event.name.padEnd(18)} ${event.actual}`);
  }
} else {
  if (!isAddress(VAULT_ADDRESS) || !RPC_URL || !AGENT_PRIVATE_KEY) throw new Error('Set VAULT_ADDRESS, RPC_URL and AGENT_PRIVATE_KEY');
  const chain = Number(process.env.CHAIN_ID ?? baseSepolia.id) === foundry.id ? foundry : baseSepolia;
  const account = privateKeyToAccount(AGENT_PRIVATE_KEY as Hex);
  const vault = new ViemVault({
    address: VAULT_ADDRESS,
    publicClient: createPublicClient({ chain, transport: http(RPC_URL) }) as never,
    walletClient: createWalletClient({ chain, transport: http(RPC_URL), account }),
    profiles,
    watchlist: [],
  });
  const fetchPrice = (key: string) => {
    const asset = getAsset(profiles, key);
    return fetchSignedResponse(priceAirnode(profiles, asset).url, priceRequest(asset));
  };
  const stale = JSON.parse(
    readFileSync(new URL('../../shared/fixtures/nodary-eth-usd.json', import.meta.url), 'utf8')
  ) as SignedResponse;
  const cases = await buildTamperSet(await fetchPrice('ETH'), await fetchPrice('BTC'), stale);
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
}
