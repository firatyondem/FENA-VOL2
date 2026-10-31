import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { EventLog, type LoggedEvent, redactUrls } from '../src/log.ts';

const event = (n: number) => ({ kind: 'payment.settled' as const, transaction: `0x${n}` });

test('numbers events and keeps only the newest', () => {
  const log = new EventLog({ capacity: 3, now: () => 42 });
  for (let n = 1; n <= 5; n++) log.append(event(n));
  assert.deepEqual(
    log.recent().map((e) => e.seq),
    [3, 4, 5]
  );
  assert.equal(log.recent()[0]?.at, 42);
  assert.deepEqual(
    log.since(4).map((e) => e.seq),
    [5]
  );
});

test('tells subscribers until they leave', () => {
  const log = new EventLog();
  const seen: LoggedEvent[] = [];
  const leave = log.subscribe((e) => seen.push(e));
  log.append(event(1));
  leave();
  log.append(event(2));
  assert.equal(seen.length, 1);
});

test('appends JSON lines to a file', () => {
  const file = pathToFileURL(join(mkdtempSync(join(tmpdir(), 'fena-log-')), 'nested', 'events.jsonl'));
  const log = new EventLog({ file });
  log.append(event(1));
  log.append(event(2));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1] as string).transaction, '0x2');
});

// The shape of a viem error from an Alchemy RPC: the key is the last part of the URL's path
const KEY = 'AbCdEf0123456789secretKEY';
const RPC_ERROR = `HTTP request failed.\n\nStatus: 403\nURL: https://base-sepolia.g.alchemy.com/v2/${KEY}\nRequest body: {"method":"eth_getBalance"}`;

test('cuts a URL down to its host, so an RPC key never reaches the log', () => {
  assert.equal(
    redactUrls(RPC_ERROR),
    'HTTP request failed.\n\nStatus: 403\nURL: https://base-sepolia.g.alchemy.com/…\nRequest body: {"method":"eth_getBalance"}'
  );
  assert.equal(redactUrls(`see https://rpc.example.org/?apikey=${KEY} now`), 'see https://rpc.example.org/… now');
  assert.equal(redactUrls(`https://user:${KEY}@rpc.example.org:8545/x`), 'https://rpc.example.org:8545/…');
  assert.equal(redactUrls('RPC https://sepolia.base.org'), 'RPC https://sepolia.base.org');
  assert.equal(redactUrls('no URL here, tx 0xabc'), 'no URL here, tx 0xabc');
});

test('logs an RPC error without its key, in memory, in the file and to subscribers', () => {
  const file = pathToFileURL(join(mkdtempSync(join(tmpdir(), 'fena-log-')), 'events.jsonl'));
  const log = new EventLog({ file });
  const seen: LoggedEvent[] = [];
  log.subscribe((e) => seen.push(e));
  log.append({ kind: 'error', where: 'cycle', message: RPC_ERROR });
  log.append({ kind: 'trigger.rejected', asset: 'ETH', stage: 'confirm', reason: RPC_ERROR });
  const stored = [JSON.stringify(log.recent()), JSON.stringify(seen), readFileSync(file, 'utf8')];
  for (const text of stored) {
    assert.ok(!text.includes(KEY));
    assert.ok(text.includes('https://base-sepolia.g.alchemy.com/…'));
  }
  assert.equal((log.recent()[0] as { message: string }).message.split('\n')[0], 'HTTP request failed.');
});

test('redacts strings nested in an event and leaves numbers and a post text as they are', () => {
  const log = new EventLog();
  const results = [{ asset: 'ETH', relevant: true, confidence: 0.9, reason: `per https://evil.example/${KEY}` }];
  const classified = log.append({ kind: 'post.classified', account: 'a', postId: '1', classifier: 'c', results } as never);
  assert.ok(!JSON.stringify(classified).includes(KEY));
  assert.equal((classified as unknown as { results: { confidence: number }[] }).results[0]?.confidence, 0.9);
  // The original event is not changed
  assert.ok(results[0]?.reason.includes(KEY));
  const text = 'Big news https://x.com/fenahackdemo/status/123';
  const seenPost = log.append({ kind: 'post.seen', account: 'fenahackdemo', postId: '123', text, createdAt: 7 });
  assert.equal((seenPost as { text: string }).text, text);
  assert.equal((seenPost as { createdAt: number }).createdAt, 7);
});
