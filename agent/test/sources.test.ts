import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Classifier } from '../src/classifier/types.ts';
import {
  guardedClassifier,
  guardedFetch,
  hostSourceOf,
  SourceBackoff,
  SourceGuard,
} from '../src/engine/sources.ts';
import { EventLog } from '../src/log.ts';

const CYCLE_MS = 30_000;

const setup = () => {
  const clock = { ms: 1_793_400_000_000 };
  const log = new EventLog({ now: () => clock.ms });
  const guard = new SourceGuard({ log, nowMs: () => clock.ms, cycleIntervalSec: 30 });
  let calls = 0;
  const fail = () =>
    guard.call('hermes', async () => {
      calls += 1;
      throw new Error('503');
    });
  const succeed = () =>
    guard.call('hermes', async () => {
      calls += 1;
      return 'price';
    });
  // [kind, failures, retryAt] for each degradation, [kind] for each recovery
  const events = (): (string | number)[][] =>
    log
      .recent()
      .flatMap((event): (string | number)[][] =>
        event.kind === 'source.degraded'
          ? [[event.kind, event.failures, event.retryAt]]
          : event.kind === 'source.recovered'
            ? [[event.kind]]
            : []
      );
  return { clock, log, guard, fail, succeed, calls: () => calls, events };
};

test('three failures in a row skip the source for 2 cycles, without calling it', async () => {
  const { guard, fail, succeed, calls, clock, log } = setup();
  await assert.rejects(fail());
  await assert.rejects(fail());
  assert.equal(log.recent().length, 0, 'two failures are no outage yet');
  await assert.rejects(fail());
  const degraded = log.recent()[0];
  assert.deepEqual(degraded?.kind === 'source.degraded' && [degraded.source, degraded.failures, degraded.retryAt], [
    'hermes',
    3,
    clock.ms + 2 * CYCLE_MS,
  ]);
  await assert.rejects(succeed(), (error: unknown) => error instanceof SourceBackoff && error.source === 'hermes');
  assert.equal(calls(), 3, 'a skipped call never reaches the source');
  clock.ms += 2 * CYCLE_MS - 1;
  await assert.rejects(succeed(), SourceBackoff);
  clock.ms += 1;
  assert.equal(await succeed(), 'price');
  assert.equal(guard.status().hermes?.degraded, false);
});

test('each failed retry doubles the skip: 2, 4, 8 cycles, at most 10 minutes', async () => {
  const { fail, clock, events } = setup();
  for (let index = 0; index < 3; index += 1) await assert.rejects(fail());
  const skips: number[] = [];
  for (let retry = 0; retry < 6; retry += 1) {
    const retryAt = events().at(-1)?.[2] as number;
    skips.push((retryAt - clock.ms) / CYCLE_MS);
    clock.ms = retryAt;
    await assert.rejects(fail(), (error: unknown) => !(error instanceof SourceBackoff));
  }
  assert.deepEqual(skips, [2, 4, 8, 16, 20, 20]);
});

test('a success after degrading logs source.recovered and starts the count over', async () => {
  const { fail, succeed, clock, events, guard } = setup();
  for (let index = 0; index < 3; index += 1) await assert.rejects(fail());
  const retryAt = clock.ms + 2 * CYCLE_MS;
  clock.ms = retryAt;
  await succeed();
  await succeed();
  assert.deepEqual(events(), [['source.degraded', 3, retryAt], ['source.recovered']]);
  // Two new failures are no outage again
  await assert.rejects(fail());
  await assert.rejects(fail());
  assert.equal(guard.status().hermes?.degraded, false);
});

test('sources back off independently', async () => {
  const { guard, fail } = setup();
  for (let index = 0; index < 3; index += 1) await assert.rejects(fail());
  assert.equal(await guard.call('posts', async () => 'post'), 'post');
  await assert.rejects(guard.call('hermes', async () => 'price'), SourceBackoff);
});

test('the fetch guard counts network errors, 5xx and 429 per source, but not 400 or 402', async () => {
  const { guard, log } = setup();
  const statuses: number[] = [];
  const inner: typeof fetch = async (input) => {
    const status = statuses.shift() ?? 200;
    if (status === 0) throw new TypeError(`fetch failed: ${String(input)}`);
    return new Response('{}', { status });
  };
  const posts = 'https://api.getxapi.com/';
  const hermes = 'https://hermes.pyth.network/';
  const fetchWithGuard = guardedFetch(inner, guard, hostSourceOf({ posts, hermes }));
  const twitter = `${posts}twitter/tweet/advanced_search`;
  const nodary = `${hermes}v2/updates/price/latest`;

  statuses.push(400, 402, 400);
  for (let index = 0; index < 3; index += 1) await fetchWithGuard(twitter);
  assert.equal(guard.status().posts?.failures, 0, 'an answer is not an outage');

  statuses.push(503, 429, 0);
  await fetchWithGuard(twitter);
  await fetchWithGuard(twitter);
  await assert.rejects(fetchWithGuard(twitter), TypeError);
  assert.equal(guard.status().posts?.degraded, true);
  await assert.rejects(fetchWithGuard(twitter), SourceBackoff);
  assert.equal((await fetchWithGuard(nodary)).status, 200, 'Hermes is fine');
  // A URL of no known source passes untouched
  statuses.push(503, 503, 503, 503);
  for (let index = 0; index < 4; index += 1) await fetchWithGuard('https://example.org/');
  assert.equal(log.recent().filter((event) => event.kind === 'source.degraded').length, 1);
});

test('the classifier behind the guard backs off after three API errors', async () => {
  const { guard } = setup();
  let calls = 0;
  const inner: Classifier = {
    name: 'claude',
    classify: async () => {
      calls += 1;
      throw new Error('529 overloaded');
    },
  };
  const classifier = guardedClassifier(inner, guard);
  assert.equal(classifier.name, 'claude');
  const post = { id: '1', text: 'ETH', author: 'demo', createdAt: 0 } as never;
  for (let index = 0; index < 3; index += 1) await assert.rejects(classifier.classify(post, []), /529/);
  await assert.rejects(classifier.classify(post, []), SourceBackoff);
  assert.equal(calls, 3);
});
