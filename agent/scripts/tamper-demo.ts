// The tamper test against the deployed vault, for the stage and for judges. It asks the vault's checkPrice, which runs
// the same price checks as every buy and sell as an eth_call: it spends nothing and needs no wallet.
//   npm run tamper-demo                       real Pyth updates from Hermes (PYTH_API_KEY), and their forgeries
//   npm run tamper-demo -- --asset BTC        the same for another asset
// Without RPC_URL or a deployment of CHAIN_ID it runs the forgeries against the SimVault bench. The same cases on real
// signed updates, plus a replayed price, run in contracts/test/fork/PythFork.t.sol.
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Address, createPublicClient, http, type PublicClient } from 'viem';
import { baseSepolia, foundry } from 'viem/chains';
import { VaultRejection } from '../src/chain/vault.ts';
import { checkPrice } from '../src/chain/viem-vault.ts';
import { formatPrice } from '../src/engine/format.ts';
import { EventLog } from '../src/log.ts';
import { loadProfiles } from '../src/profiles.ts';
import { HermesClient, type PriceUpdate } from '../src/pyth/hermes.ts';
import { HermesPriceSource } from '../src/pyth/price-source.ts';
import { runTamperBench } from '../src/replay.ts';
import { buildTamperSet } from './tamper-set.ts';

const { values } = parseArgs({ options: { asset: { type: 'string', default: 'ETH' } } });

const profiles = loadProfiles();
const { RPC_URL } = process.env;
const chain = Number(process.env.CHAIN_ID || baseSepolia.id) === foundry.id ? foundry : baseSepolia;
const deploymentFile = new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url);
const vaultAddress =
  process.env.VAULT_ADDRESS ||
  (existsSync(deploymentFile) ? (JSON.parse(readFileSync(deploymentFile, 'utf8')) as { vault: Address }).vault : undefined);

// What the vault's checkPrice says: its price and the time it read, or its refusal
const askVault = async (publicClient: PublicClient, address: Address, asset: string, update: PriceUpdate) => {
  try {
    const { price, priceTime } = await checkPrice(publicClient, address, asset, update);
    const published = new Date(Number(priceTime) * 1000).toISOString();
    return { actual: 'accepted', detail: `read ${asset} at ${formatPrice(price)}, published ${published}` };
  } catch (error) {
    if (error instanceof VaultRejection) return { actual: error.reason, detail: 'refused by the vault' };
    throw error;
  }
};

if (!RPC_URL || !vaultAddress) {
  console.log('No RPC_URL or deployed vault: running the forgeries against the SimVault bench.\n');
  const log = new EventLog();
  await runTamperBench(profiles, log);
  let failed = 0;
  for (const event of log.recent()) {
    if (event.kind !== 'tamper.result') continue;
    if (!event.passed) failed += 1;
    console.log(`${event.passed ? 'PASS' : 'FAIL'}  ${event.name}: expected ${event.expected}, got ${event.actual}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) }) as PublicClient;
const prices = new HermesPriceSource(profiles, new HermesClient({ apiKey: process.env.PYTH_API_KEY, baseUrl: profiles.pyth.hermesUrl }));
const cases = await buildTamperSet(profiles, prices, values.asset ?? 'ETH', Math.floor(Date.now() / 1000));
console.log(`Vault ${vaultAddress} on ${chain.name}, asset ${values.asset}\n`);
let failed = 0;
for (const testCase of cases) {
  const { actual, detail } = await askVault(publicClient, vaultAddress as Address, values.asset ?? 'ETH', {
    updates: testCase.update,
    prices: [],
  });
  const passed = actual === testCase.expected;
  if (!passed) failed += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${testCase.name}: ${testCase.how}`);
  console.log(`      expected ${testCase.expected}, got ${actual} (${detail})\n`);
}
process.exit(failed === 0 ? 0 : 1);
