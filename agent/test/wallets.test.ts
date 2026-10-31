import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Address, HttpRequestError, parseEther, parseUnits } from 'viem';
import type { Rule } from '../src/chain/vault.ts';
import { activeWatchSet } from '../src/engine/watch-set.ts';
import {
  addressLink,
  checkWallets,
  describeRpcError,
  estimateRuntimeHours,
  paidCallsPerHour,
  walletLimits,
  type WalletReport,
} from '../scripts/wallets.ts';

const AGENT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PAYER: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const limits = walletLimits({});
const funded: WalletReport = {
  agent: { address: AGENT, eth: parseEther('0.02') },
  payer: { address: PAYER, ausd: parseUnits('3', 6) },
  rulesNamingAgent: 1,
};

const failed = (report: WalletReport) =>
  checkWallets(report, limits)
    .filter((check) => !check.ok)
    .map((check) => check.message);

test('the default limits are the spec settings: 0.0005 ETH and 0.2 aUSD', () => {
  assert.equal(limits.minEth, parseEther('0.0005'));
  assert.equal(limits.minAusd, 200_000n);
  assert.deepEqual(walletLimits({ AGENT_MIN_ETH: '0.01', PAYER_MIN_AUSD: '3' }), {
    minEth: parseEther('0.01'),
    minAusd: 3_000_000n,
  });
});

test('funded, separate wallets with a rule naming the agent pass every check', () => {
  const checks = checkWallets(funded, limits);
  assert.equal(checks.length, 4);
  assert.deepEqual(failed(funded), []);
  assert.match(checks[2]?.message ?? '', /different wallets/);
  assert.match(checks[3]?.message ?? '', /1 user names this agent/);
});

test('low balances fail against the minimums, at the exact edge too', () => {
  const atEdge = { ...funded, agent: { address: AGENT, eth: limits.minEth }, payer: { address: PAYER, ausd: limits.minAusd } };
  assert.deepEqual(failed(atEdge), []);
  const below = {
    ...funded,
    agent: { address: AGENT, eth: limits.minEth - 1n },
    payer: { address: PAYER, ausd: limits.minAusd - 1n },
  };
  const messages = failed(below);
  assert.equal(messages.length, 2);
  assert.match(messages[0] ?? '', /agent wallet holds 0.000499999999999999 ETH/);
  assert.match(messages[1] ?? '', /payer wallet holds 0.199999 aUSD/);
});

test('one wallet for both roles fails, and missing keys are named', () => {
  const same = { ...funded, payer: { address: AGENT, ausd: parseUnits('3', 6) } };
  assert.match(failed(same)[0] ?? '', /same wallet/);
  const messages = failed({ rulesUnavailable: 'no agent wallet' });
  assert.deepEqual(messages, [
    'AGENT_PRIVATE_KEY is not set in agent/.env',
    'PAYER_PRIVATE_KEY is not set in agent/.env',
    'could not read the rules: no agent wallet',
  ]);
});

test('no rule naming the agent says how to approve it', () => {
  assert.deepEqual(failed({ ...funded, rulesNamingAgent: 0 }), [
    `No user has approved this agent yet: save a rule in the frontend naming ${AGENT}`,
  ]);
});

test('the runtime estimate divides the aUSD by the hourly cost of the paid polls', () => {
  // Two accounts every 60 s: 120 calls/h at 0.01 aUSD = 1.2 aUSD/h, so 3 aUSD last 2.5 h
  assert.equal(paidCallsPerHour(2, 60), 120);
  assert.equal(estimateRuntimeHours(parseUnits('3', 6), 120), 2.5);
  assert.equal(paidCallsPerHour(1, 120), 30);
  assert.equal(estimateRuntimeHours(parseUnits('0.3', 6), 30), 1);
  // No rule, no paid call
  assert.equal(paidCallsPerHour(0, 60), 0);
  assert.equal(estimateRuntimeHours(parseUnits('3', 6), 0), undefined);
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
