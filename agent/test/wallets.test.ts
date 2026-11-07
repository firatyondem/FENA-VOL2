import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Address, HttpRequestError, parseEther } from 'viem';
import type { Rule } from '../src/chain/vault.ts';
import { activeWatchSet } from '../src/engine/watch-set.ts';
import { addressLink, checkWallets, describeRpcError, walletLimits, type WalletReport } from '../scripts/wallets.ts';

const AGENT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const FAUCET: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const limits = walletLimits({});
const funded: WalletReport = {
  agent: { address: AGENT, eth: parseEther('0.02') },
  faucet: { address: FAUCET, eth: parseEther('0.5') },
  rulesNamingAgent: 1,
};

const failed = (report: WalletReport) =>
  checkWallets(report, limits)
    .filter((check) => !check.ok)
    .map((check) => check.message);

test('the default minimum is the spec setting: 0.0005 ETH', () => {
  assert.equal(limits.minEth, parseEther('0.0005'));
  assert.deepEqual(walletLimits({ AGENT_MIN_ETH: '0.01' }), { minEth: parseEther('0.01') });
});

test('a funded agent with a rule naming it passes every check', () => {
  const checks = checkWallets(funded, limits);
  assert.equal(checks.length, 2);
  assert.deepEqual(failed(funded), []);
  assert.match(checks[1]?.message ?? '', /1 user names this agent/);
});

test('a low balance fails against the minimum, at the exact edge too', () => {
  assert.deepEqual(failed({ ...funded, agent: { address: AGENT, eth: limits.minEth } }), []);
  const messages = failed({ ...funded, agent: { address: AGENT, eth: limits.minEth - 1n } });
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /agent wallet holds 0.000499999999999999 ETH/);
});

test('one wallet for the agent and the faucet fails, and a missing key is named', () => {
  const same = { ...funded, faucet: { address: AGENT, eth: parseEther('1') } };
  assert.match(failed(same)[0] ?? '', /same wallet/);
  assert.deepEqual(failed({ rulesUnavailable: 'no agent wallet' }), [
    'AGENT_PRIVATE_KEY is not set in agent/.env',
    'could not read the rules: no agent wallet',
  ]);
});

test('no rule naming the agent says how to approve it', () => {
  assert.deepEqual(failed({ ...funded, rulesNamingAgent: 0 }), [
    `No user has approved this agent yet: save a rule in the frontend naming ${AGENT}`,
  ]);
});

test('the active watch set holds accounts of unpaused rules with linked assets only', () => {
  const rule = (id: string, paused: boolean, accounts: Record<string, string[]>) =>
    ({ id, paused, accounts }) as unknown as Rule;
  const rules = [
    rule('a', false, { realDonaldTrump: ['ETH'], elonmusk: [] }),
    rule('b', true, { JDVance: ['BTC'] }),
    rule('c', false, { realDonaldTrump: ['BTC'], demo: ['DOGE'] }),
  ];
  assert.deepEqual(activeWatchSet(rules), ['demo', 'realDonaldTrump']);
  assert.deepEqual(activeWatchSet([]), []);
});

test('the basescan link names the address', () => {
  assert.equal(addressLink(AGENT), `https://sepolia.basescan.org/address/${AGENT}`);
});

test('an RPC error is described in one line, without the RPC URL and its key', () => {
  const error = new HttpRequestError({
    url: 'https://base-sepolia.g.alchemy.com/v2/AbCdEf0123456789secretKEY',
    status: 403,
    details: 'BASE_SEPOLIA is not enabled for this app',
  });
  assert.ok(error.message.includes('secretKEY'));
  assert.equal(describeRpcError(error), 'HTTP request failed. BASE_SEPOLIA is not enabled for this app');
  assert.equal(
    describeRpcError(new Error('fetch failed for https://rpc.example.org/v2/secretKEY\nmore')),
    'fetch failed for https://rpc.example.org/…'
  );
});
