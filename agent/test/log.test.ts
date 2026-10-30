import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { EventLog, type LoggedEvent } from '../src/log.ts';

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
