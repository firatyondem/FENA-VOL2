import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BACKOFF_MS, MAX_RESTARTS_PER_HOUR, RestartPolicy, STABLE_UPTIME_MS } from '../scripts/supervise.ts';

const crash = (nowMs: number, uptimeMs = 1_000) => ({ code: 1, stopping: false, uptimeMs, nowMs });

test('crashes in a row back off 5 s, 10 s, 20 s, then 60 s', () => {
  const policy = new RestartPolicy();
  const delays = [0, 1, 2, 3, 4].map((index) => {
    const decision = policy.onExit(crash(index * 120_000));
    return decision.action === 'restart' ? decision.delayMs : decision.action;
  });
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 60_000, 60_000]);
  assert.deepEqual(BACKOFF_MS, [5_000, 10_000, 20_000, 60_000]);
  assert.equal(policy.restarts, 5);
});

test('a run of ten minutes resets the backoff', () => {
  const policy = new RestartPolicy();
  policy.onExit(crash(0));
  policy.onExit(crash(60_000));
  assert.deepEqual(policy.onExit(crash(2 * 60_000, STABLE_UPTIME_MS)), { action: 'restart', delayMs: 5_000, restarts: 3 });
  assert.deepEqual(policy.onExit(crash(20 * 60_000, STABLE_UPTIME_MS - 1)), { action: 'restart', delayMs: 10_000, restarts: 4 });
});

test('Ctrl+C and a clean exit stop for good; a signal is a crash', () => {
  const policy = new RestartPolicy();
  assert.deepEqual(policy.onExit({ code: 1, stopping: true, uptimeMs: 1, nowMs: 0 }), { action: 'stop' });
  assert.deepEqual(policy.onExit({ code: null, stopping: true, uptimeMs: 1, nowMs: 0 }), { action: 'stop' });
  assert.deepEqual(policy.onExit({ code: 0, stopping: false, uptimeMs: 1, nowMs: 0 }), { action: 'stop' });
  // `kill <pid>` on Linux ends the child by a signal: restart, as for any crash
  assert.equal(policy.onExit({ code: null, stopping: false, uptimeMs: 1, nowMs: 0 }).action, 'restart');
  assert.equal(policy.restarts, 1);
});

test('more than 20 restarts in an hour gives up; an hour later restarts resume', () => {
  const policy = new RestartPolicy();
  for (let index = 0; index < MAX_RESTARTS_PER_HOUR; index += 1) {
    assert.equal(policy.onExit(crash(index * 60_000)).action, 'restart');
  }
  assert.deepEqual(policy.onExit(crash(20 * 60_000)), { action: 'give-up', reason: '20 restarts in the last hour' });
  // The first restart (at 0) has left the hour
  assert.equal(policy.onExit(crash(3_600_000 + 1)).action, 'restart');
});

// Runs a module in a new Node process that installs the crash handlers on a log file and then fails as `failure` says
const runCrashing = (failure: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-crash-'));
  try {
    const file = pathToFileURL(join(dir, 'events.jsonl')).href;
    const source = [
      `import { EventLog } from ${JSON.stringify(new URL('../src/log.ts', import.meta.url).href)};`,
      `import { installCrashHandlers } from ${JSON.stringify(new URL('../src/live.ts', import.meta.url).href)};`,
      `installCrashHandlers(new EventLog({ file: new URL(${JSON.stringify(file)}) }));`,
      failure,
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30_000 });
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; where: string; message: string; seq: number; at: number });
    return { status: result.status, events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('an uncaught exception is logged and exits with code 1, so the supervisor restarts', () => {
  const { status, events } = runCrashing("setTimeout(() => { throw new Error('boom in a timer'); }, 0);");
  assert.equal(status, 1);
  assert.deepEqual(events, [
    { kind: 'error', where: 'uncaught exception, exiting', message: 'boom in a timer', seq: 1, at: events[0]?.at },
  ]);
});

test('an unhandled rejection is logged and exits with code 1', () => {
  const { status, events } = runCrashing("Promise.reject(new Error('poll failed unseen'));");
  assert.equal(status, 1);
  assert.equal(events[0]?.where, 'unhandled rejection, exiting');
  assert.equal(events[0]?.message, 'poll failed unseen');
});
