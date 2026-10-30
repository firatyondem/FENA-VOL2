// Fetches a signed price for each asset, checks it against the profile's Airnode and request, and prints it. Nodary is
// free; TickerLayer needs PAYER_PRIVATE_KEY. Pass --save to keep the responses in shared/fixtures/live/, which also
// settles the spec's open question about TickerLayer's field names and timestamp unit.
// Run with `npm run fetch-prices [-- ETH OIL --save]`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isHex } from 'viem';
import { deriveRequestHash, verifySignedResponse } from '../src/airnode/attestation.ts';
import { createPayingFetch, fetchSignedResponse } from '../src/airnode/client.ts';
import { formatFixedPoint } from '../src/airnode/projected-json.ts';
import { getAsset, loadProfiles, priceAirnode, priceRequest, readSignedPrice } from '../src/profiles.ts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { save: { type: 'boolean', default: false } } });
const profiles = loadProfiles();
const assets = positionals.length > 0 ? positionals : Object.keys(profiles.assets);
const payer = process.env.PAYER_PRIVATE_KEY;
const airnodeFetch = payer && isHex(payer) ? createPayingFetch(payer) : fetch;
const directory = new URL('../../shared/fixtures/live/', import.meta.url);

for (const key of assets) {
  const asset = getAsset(profiles, key);
  const { url, address } = priceAirnode(profiles, asset);
  try {
    const response = await fetchSignedResponse(url, priceRequest(asset), airnodeFetch);
    await verifySignedResponse(response, address, deriveRequestHash(priceRequest(asset)));
    const price = readSignedPrice(profiles, asset, response);
    const age = Math.floor(Date.now() / 1000) - price.sourceTime;
    console.log(`${key.padEnd(5)} ${formatFixedPoint(price.price, 18).padStart(12)} USD  source ${age}s ago  ${response.data}`);
    if (values.save) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(new URL(`${key.toLowerCase()}-${response.timestamp}.json`, directory), `${JSON.stringify(response, null, 2)}\n`);
    }
  } catch (error) {
    console.log(`${key.padEnd(5)} failed: ${(error as Error).message}`);
  }
}
