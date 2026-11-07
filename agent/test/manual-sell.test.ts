import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hex } from 'viem';
import { fetchFromAgent, manualSell, SELL_REASON } from '../../shared/pyth/manual-sell.mts';

const VAULT = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test('the website helper asks the agent for an update, then sells as Manual with the vault’s fee', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, 'https://agent.example/api/price-update?asset=ETH');
    return new Response(JSON.stringify({ asset: 'ETH', updates: ['0x504e4155'], fee: '30' }));
  }) as typeof fetch;
  let updates: Hex[];
  try {
    updates = await fetchFromAgent('https://agent.example/', 'ETH');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(updates, ['0x504e4155']);

  const simulated: { args: unknown[]; value: bigint; functionName: string }[] = [];
  const publicClient = {
    readContract: async () => 30n,
    simulateContract: async (params: { args: unknown[]; value: bigint; functionName: string }) => {
      simulated.push(params);
      return { request: params };
    },
  };
  const wallet = { account: { address: OWNER }, writeContract: async () => '0xhash' };
  const hash = await manualSell(publicClient as never, wallet as never, VAULT, 7n, updates);
  assert.equal(hash, '0xhash');
  assert.equal(simulated[0]?.functionName, 'sell');
  assert.deepEqual(simulated[0]?.args, [7n, SELL_REASON.manual, ['0x504e4155']]);
  assert.equal(simulated[0]?.value, 30n);
});
