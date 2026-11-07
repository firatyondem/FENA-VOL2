// Writes real, signed Pyth price updates to shared/fixtures/pyth/, in the shape Hermes serves them. Run with
// `npm run pyth-fixtures`.
//
// Hermes needs an API key since 2026-08-26, so the updates come from Base Sepolia instead: each one is the exact bytes
// that someone already sent to the chain's Pyth contract, which verified them there. The script finds the
// accumulator update ("PNAU") in the transaction's input and keeps it as it is.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, type Hex, http, bytesToHex, hexToBytes } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readAccumulatorUpdate } from '../src/pyth/accumulator.ts';
import { hermesResponse } from '../src/pyth/hermes.ts';

const RPC_URL = process.env.RPC_URL ?? 'https://base-sepolia-rpc.publicnode.com';

// ETH/USD: P0 at its low, P1 30 min 40 s later at its high (+0.36%), and a later price below the buy (-0.09%)
const FIXTURES: { file: string; txHash: Hex; note: string }[] = [
  {
    file: 'eth-p0.json',
    txHash: '0xe4c47aa1cd29055bc1236b9c7320cf190dd624f4f1633da9ee598a2482c6324b',
    note: 'ETH/USD 2236.50 and BTC/USD, published 1794057378',
  },
  {
    file: 'eth-p1.json',
    txHash: '0x2c8569ac9aca940b3d357004c122ab2f9f85ec11d0a98533a0bc016dcef33405',
    note: 'ETH/USD 2244.65, 30 min 40 s after eth-p0 (+0.36%)',
  },
  {
    file: 'eth-later.json',
    txHash: '0xe8cf8dbb08b5627e0507199db34945654294172c878d6c6ce63870c322e0979d',
    note: 'ETH/USD 2242.63, 75 min after eth-p1 (-0.09%)',
  },
];

const MAGIC = [0x50, 0x4e, 0x41, 0x55];

// Every accumulator update in a transaction's calldata: an ABI `bytes` value has its length in the 32 bytes before it.
export const updatesInCalldata = (input: Hex): Hex[] => {
  const bytes = hexToBytes(input);
  const found: Hex[] = [];
  for (let i = 32; i + 4 <= bytes.length; i++) {
    if (MAGIC.every((byte, k) => bytes[i + k] === byte)) {
      let length = 0n;
      for (let k = i - 32; k < i; k++) length = (length << 8n) | BigInt(bytes[k] as number);
      const update = bytesToHex(bytes.slice(i, i + Number(length)));
      readAccumulatorUpdate(update);
      found.push(update);
    }
  }
  return found;
};

const main = async () => {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const directory = new URL('../../shared/fixtures/pyth/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  for (const fixture of FIXTURES) {
    const tx = await client.getTransaction({ hash: fixture.txHash });
    const updates = updatesInCalldata(tx.input);
    if (updates.length !== 1) throw new Error(`${fixture.txHash} holds ${updates.length} updates, expected 1`);
    const response = {
      ...hermesResponse(updates),
      source: { chainId: baseSepolia.id, txHash: fixture.txHash, blockNumber: Number(tx.blockNumber), note: fixture.note },
    };
    writeFileSync(new URL(fixture.file, directory), `${JSON.stringify(response, null, 2)}\n`);
    console.log(`${fixture.file}: ${fixture.note}`);
  }
};

if (import.meta.main) await main();
