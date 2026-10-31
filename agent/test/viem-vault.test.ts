import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  type Hex,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { vaultAbi } from '../src/chain/vault-abi.ts';
import { TxTimeout, VaultRejection } from '../src/chain/vault.ts';
import { assetIdOf, revertReason, toVaultResponse, ViemVault } from '../src/chain/viem-vault.ts';
import { loadProfiles } from '../src/profiles.ts';
import { readSharedJson } from './helpers.ts';

const fixture = (file: string) => readSharedJson<SignedResponse>(`fixtures/synthetic/${file}`);
const VAULT: Address = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const USER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const revert = (errorName: string, args: unknown[] = []) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: vaultAbi,
      data: encodeErrorResult({ abi: vaultAbi, errorName, args } as never),
      functionName: 'confirmTrigger',
    }),
    { abi: vaultAbi, functionName: 'confirmTrigger', args: [], contractAddress: VAULT }
  );

// A vault whose simulation records each call and then fails, so no transaction is sent
const recordingVault = (failWith: Error) => {
  const sent: Hex[] = [];
  const publicClient = {
    simulateContract: async (params: { functionName: string; args: unknown[] }) => {
      const { encodeFunctionData } = await import('viem');
      sent.push(encodeFunctionData({ abi: vaultAbi, functionName: params.functionName, args: params.args } as never));
      throw failWith;
    },
  };
  const vault = new ViemVault({
    address: VAULT,
    publicClient: publicClient as never,
    walletClient: { account: { address: USER }, writeContract: async () => '0xfeed' } as never,
    profiles: loadProfiles(),
    watchlist: [],
  });
  return { vault, sent };
};

test('asset ids are keccak256 of the key, as the deploy script registers them', () => {
  const deployment = readSharedJson<{ assetIds: Record<string, Hex> }>('deployments/31337.json');
  for (const [key, id] of Object.entries(deployment.assetIds)) assert.equal(assetIdOf(key), id, key);
});

test('a signed response goes to the vault with its request hash and its data as exact bytes', () => {
  const post = fixture('tweet-musk-doge.json');
  const encoded = toVaultResponse(post);
  assert.equal(encoded.requestHash, post.requestHash);
  assert.equal(encoded.timestamp, BigInt(post.timestamp));
  assert.equal(Buffer.from(encoded.data.slice(2), 'hex').toString('utf8'), post.data);
  assert.equal(encoded.signature, post.signature);
});

test('opens a trigger as openTrigger(user, assetId, tweet, p0) and names the revert', async () => {
  const { vault, sent } = recordingVault(revert('AccountNotWatched', [USER, '0x' + '11'.repeat(32)]));
  await assert.rejects(
    vault.openTrigger({
      ruleId: USER,
      asset: 'OIL',
      account: 'realDonaldTrump',
      post: fixture('tweet-trump-venezuela.json'),
      p0: fixture('oil-p0.json'),
    }),
    (error) => error instanceof VaultRejection && error.reason === 'AccountNotWatched'
  );
  const decoded = decodeFunctionData({ abi: vaultAbi, data: sent[0] as Hex });
  assert.equal(decoded.functionName, 'openTrigger');
  if (decoded.functionName !== 'openTrigger') return;
  const [user, assetId, tweet, p0] = decoded.args;
  assert.equal(user, USER);
  assert.equal(assetId, assetIdOf('OIL'));
  assert.equal(tweet.requestHash, fixture('tweet-trump-venezuela.json').requestHash);
  assert.equal(p0.timestamp, BigInt(fixture('oil-p0.json').timestamp));
});

test('maps sells to the vault reasons and refuses a stop loss the vault does not have', async () => {
  const { vault, sent } = recordingVault(revert('TakeProfitNotReached', [1n, 2n]));
  await assert.rejects(vault.sell('3', 'take-profit', fixture('eth-p1-rise.json')), { reason: 'TakeProfitNotReached' });
  const decoded = decodeFunctionData({ abi: vaultAbi, data: sent[0] as Hex });
  assert.equal(decoded.functionName, 'sell');
  if (decoded.functionName === 'sell') assert.equal(decoded.args[1], 1);
  await assert.rejects(vault.sell('3', 'stop-loss', fixture('eth-p1-rise.json')), { reason: 'SellKindNotSupported' });
  assert.equal(sent.length, 1, 'the stop loss never reached the chain');
  assert.deepEqual(vault.keeperSellKinds, ['take-profit', 'stagnation']);
});

test('names the attestation error of a forged response', () => {
  assert.equal(revertReason(revert('NotSignedByAirnode', ['0x9aAD9AF9D2d0B9429F6e1C18FA733F41926BC678'])), 'NotSignedByAirnode');
  assert.equal(revertReason(revert('SpikeTooHigh', [1n, 2n])), 'SpikeTooHigh');
  assert.equal(revertReason(new Error('socket hang up')), 'socket hang up');
});

test('an RPC failure is not a refusal: it passes through so the engine retries', async () => {
  const { vault } = recordingVault(new Error('fetch failed'));
  await assert.rejects(
    vault.openTrigger({
      ruleId: USER,
      asset: 'OIL',
      account: 'realDonaldTrump',
      post: fixture('tweet-trump-venezuela.json'),
      p0: fixture('oil-p0.json'),
    }),
    (error) => !(error instanceof VaultRejection) && /fetch failed/.test(String(error))
  );
});

// A vault whose simulation passes and whose send returns HASH; `receipt` decides what mining does
const HASH: Hex = `0x${'ab'.repeat(32)}`;
const sendingVault = (receipt: () => Promise<unknown>, txTimeoutMs?: number) =>
  new ViemVault({
    address: VAULT,
    publicClient: {
      simulateContract: async (params: unknown) => ({ request: params }),
      waitForTransactionReceipt: receipt,
    } as never,
    walletClient: { account: { address: USER }, writeContract: async () => HASH } as never,
    profiles: loadProfiles(),
    watchlist: [],
    ...(txTimeoutMs === undefined ? {} : { txTimeoutMs }),
  });

test('a stuck transaction times out with its hash instead of hanging the agent', async () => {
  // A client that never answers, as with a dropped transaction
  const vault = sendingVault(() => new Promise(() => {}), 20);
  const started = Date.now();
  await assert.rejects(vault.expireTrigger('7'), (error: unknown) => {
    assert.ok(error instanceof TxTimeout, 'a timeout, not a vault refusal');
    assert.ok(!(error instanceof VaultRejection));
    assert.equal(error.hash, HASH);
    assert.match(error.message, new RegExp(HASH));
    return true;
  });
  assert.ok(Date.now() - started < 2000, 'gave up at the timeout');
});

test("viem's own receipt timeout becomes a TxTimeout too", async () => {
  const vault = sendingVault(async () => {
    throw new WaitForTransactionReceiptTimeoutError({ hash: HASH });
  });
  await assert.rejects(vault.expireTrigger('7'), (error: unknown) => error instanceof TxTimeout && error.hash === HASH);
});

test('a mined transaction reports its gas: gasUsed times the effective gas price', async () => {
  const vault = sendingVault(async () => ({
    status: 'success',
    logs: [],
    gasUsed: 60_000n,
    effectiveGasPrice: 1_500_000_000n,
  }));
  assert.deepEqual(await vault.expireTrigger('7'), { txHash: HASH, gasWei: 90_000_000_000_000n });
});

test('names a revert that first shows up when the transaction is sent', async () => {
  // Like viem: the simulation passes and hands back a request whose ABI holds only the called function, and the send
  // decodes its revert with the ABI it was given
  const publicClient = {
    simulateContract: async (params: { functionName: string; args: unknown[] }) => ({
      request: { ...params, abi: vaultAbi.filter((item) => 'name' in item && item.name === params.functionName) },
    }),
  };
  const walletClient = {
    account: { address: USER },
    writeContract: async (request: { abi: typeof vaultAbi; functionName: string }) => {
      throw new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({
          abi: request.abi,
          data: encodeErrorResult({ abi: vaultAbi, errorName: 'ResponseTooOld', args: [1n] }),
          functionName: request.functionName,
        }),
        { abi: request.abi, functionName: request.functionName, args: [], contractAddress: VAULT }
      );
    },
  };
  const vault = new ViemVault({
    address: VAULT,
    publicClient: publicClient as never,
    walletClient: walletClient as never,
    profiles: loadProfiles(),
    watchlist: [],
  });
  await assert.rejects(vault.expireTrigger('1'), { reason: 'ResponseTooOld' });
});
