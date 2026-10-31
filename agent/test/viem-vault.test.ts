import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  type Hex,
} from 'viem';
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { vaultAbi } from '../src/chain/vault-abi.ts';
import { VaultRejection } from '../src/chain/vault.ts';
import { assetIdOf, checkPrice, revertReason, toVaultResponse, ViemVault } from '../src/chain/viem-vault.ts';
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

test('checkPrice reads the vault with no wallet, names a refusal and passes an RPC failure through', async () => {
  const response = fixture('eth-p1-rise.json');
  const asked: { functionName: string; args: unknown[] }[] = [];
  const answering = (answer: () => unknown) =>
    ({
      readContract: async (params: { functionName: string; args: unknown[] }) => {
        asked.push(params);
        return answer();
      },
    }) as never;

  const read = await checkPrice(answering(() => [2070n, 1793381220n]), VAULT, 'ETH', response);
  assert.deepEqual(read, { price: 2070n, priceTime: 1793381220n });
  assert.equal(asked[0]?.functionName, 'checkPrice');
  assert.deepEqual(asked[0]?.args, [assetIdOf('ETH'), toVaultResponse(response)]);

  await assert.rejects(
    checkPrice(answering(() => { throw revert('ResponseTooOld', [1n]); }), VAULT, 'ETH', response),
    (error) => error instanceof VaultRejection && error.reason === 'ResponseTooOld'
  );
  await assert.rejects(
    checkPrice(answering(() => { throw new Error('rpc down'); }), VAULT, 'ETH', response),
    /rpc down/
  );
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
