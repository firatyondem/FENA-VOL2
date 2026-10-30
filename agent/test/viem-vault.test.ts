import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  type Log,
} from 'viem';
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { vaultAbi } from '../src/chain/vault-abi.ts';
import { VaultRejection } from '../src/chain/vault.ts';
import { revertReason, ViemVault } from '../src/chain/viem-vault.ts';
import { readSharedJson } from './helpers.ts';

const fixture = (file: string) => readSharedJson<SignedResponse>(`fixtures/synthetic/${file}`);
const OIL: Address = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const VAULT: Address = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707';

const log = (eventName: 'TriggerOpened' | 'TriggerConfirmed' | 'PositionSold', args: Record<string, unknown>, data: Hex): Log =>
  ({
    address: VAULT,
    topics: encodeEventTopics({ abi: vaultAbi, eventName, args } as never),
    data,
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  }) as Log;

const revert = (errorName: string, args: unknown[] = []) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: vaultAbi,
      data: encodeErrorResult({ abi: vaultAbi, errorName, args } as never),
      functionName: 'confirmTrigger',
    }),
    { abi: vaultAbi, functionName: 'confirmTrigger', args: [], contractAddress: VAULT }
  );

const makeVault = (logs: Log[], failWith?: Error) => {
  const sent: Hex[] = [];
  const publicClient = {
    simulateContract: async (params: { functionName: string; args: unknown[] }) => {
      if (failWith) throw failWith;
      sent.push(encodeFunctionData({ abi: vaultAbi, functionName: params.functionName, args: params.args } as never));
      return { request: params };
    },
    waitForTransactionReceipt: async () => ({ status: 'success', logs }),
  };
  const walletClient = { account: { address: VAULT }, writeContract: async () => '0xfeed' };
  const vault = new ViemVault({
    address: VAULT,
    publicClient: publicClient as never,
    walletClient: walletClient as never,
    assets: { OIL },
    rules: [],
  });
  return { vault, sent };
};

test('opens a trigger with each signed response as (timestamp, data, signature)', async () => {
  const opened = log(
    'TriggerOpened',
    { triggerId: 7n, ruleId: 1n, asset: OIL },
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 70n, 1n])
  );
  const { vault, sent } = makeVault([opened]);
  const post = fixture('tweet-trump-venezuela.json');
  const result = await vault.openTrigger({ ruleId: '1', asset: 'OIL', account: 'realDonaldTrump', post, p0: fixture('oil-p0.json') });
  assert.deepEqual(result, { triggerId: '7', txHash: '0xfeed' });

  const decoded = decodeFunctionData({ abi: vaultAbi, data: sent[0] as Hex });
  assert.equal(decoded.functionName, 'openTrigger');
  if (decoded.functionName !== 'openTrigger') return;
  const [ruleId, asset, account, postArg] = decoded.args;
  assert.equal(ruleId, 1n);
  assert.equal(asset, OIL);
  assert.equal(account, 'realDonaldTrump');
  assert.equal(postArg.timestamp, BigInt(post.timestamp));
  assert.equal(Buffer.from(postArg.data.slice(2), 'hex').toString('utf8'), post.data);
});

test('records the bought position with its rule and asset', async () => {
  const opened = log(
    'TriggerOpened',
    { triggerId: 7n, ruleId: 1n, asset: OIL },
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 70n, 1n])
  );
  const confirmed = log(
    'TriggerConfirmed',
    { triggerId: 7n, positionId: 3n },
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [500_000_000n, 7n * 10n ** 18n, 714n * 10n ** 17n])
  );
  const { vault } = makeVault([opened, confirmed]);
  await vault.openTrigger({
    ruleId: '1',
    asset: 'OIL',
    account: 'realDonaldTrump',
    post: fixture('tweet-trump-venezuela.json'),
    p0: fixture('oil-p0.json'),
  });
  const bought = await vault.confirmTrigger('7', fixture('oil-p1-rise.json'));
  assert.equal(bought.positionId, '3');
  assert.equal(bought.usdcIn, 500_000_000n);
  const [position] = await vault.listPositions();
  assert.equal(position?.ruleId, '1');
  assert.equal(position?.asset, 'OIL');
  assert.equal(position?.entryPrice, 714n * 10n ** 17n);
});

test('turns a simulated revert into the vault error name before any transaction', async () => {
  const { vault } = makeVault([], revert('AboveSpikeCap'));
  await assert.rejects(
    vault.confirmTrigger('7', fixture('eth-p1-spike.json')),
    (error) => error instanceof VaultRejection && error.reason === 'AboveSpikeCap'
  );
});

test('names the signer error of a forged response', () => {
  assert.equal(revertReason(revert('NotSignedByAirnode', ['0x9aAD9AF9D2d0B9429F6e1C18FA733F41926BC678'])), 'NotSignedByAirnode');
  assert.equal(revertReason(new Error('socket hang up')), 'socket hang up');
});

test('refuses an asset the deployment does not list', async () => {
  const { vault } = makeVault([]);
  await assert.rejects(
    vault.openTrigger({
      ruleId: '1',
      asset: 'TSLA',
      account: 'elonmusk',
      post: fixture('tweet-musk-doge.json'),
      p0: fixture('eth-p0.json'),
    }),
    (error) => error instanceof VaultRejection && error.reason === 'AssetNotDeployed'
  );
});
