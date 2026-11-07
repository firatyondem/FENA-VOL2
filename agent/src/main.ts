// Starts the agent and its console. AGENT_MODE=replay (the default) runs the stage replay without keys or a chain;
// AGENT_MODE=live watches real accounts and talks to the deployed vault.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ClaudeClassifier, LARGE_CLASSIFIER_MODEL, SMALL_CLASSIFIER_MODEL } from './classifier/claude.ts';
import { KeywordClassifier } from './classifier/keyword.ts';
import { TieredClassifier, VerdictCache } from './classifier/tiered.ts';
import type { Classifier } from './classifier/types.ts';
import { startConsoleServer } from './console/server.ts';
import { ledgerRecorder } from './engine/costs.ts';
import { EventLog } from './log.ts';
import { loadProfiles } from './profiles.ts';
import { startReplay } from './replay.ts';
import { openDb } from './store/db.ts';
import { DecisionLog } from './store/decisions.ts';
import { CostLedger } from './store/ledger.ts';
import { buildTamperSet } from '../scripts/tamper-set.ts';

const profiles = loadProfiles();
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
// The event log and the database: agent/.data/ by default, a persistent volume when hosted
const dataDir = process.env.DATA_DIR
  ? pathToFileURL(`${process.env.DATA_DIR.replace(/[\\/]+$/, '')}/`)
  : new URL('../.data/', import.meta.url);
// Events carry the agent's clock, which the replay runs faster than real time.
let agentNow = () => Math.floor(Date.now() / 1000);
const log = new EventLog({ file: new URL('events.jsonl', dataDir), now: () => agentNow() * 1000 });
const port = Number(process.env.PORT || process.env.CONSOLE_PORT || 4173);
const host = process.env.CONSOLE_HOST || '127.0.0.1';
// The website's origins, comma-separated: only their pages may call the API
const allowedOrigins = process.env.CONSOLE_ALLOWED_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const mode = process.env.AGENT_MODE || 'replay';
// The replay keeps its ledger and decisions in memory, so a demo never mixes with a live run's records
const db = openDb(mode === 'live' ? new URL('agent.db', dataDir) : ':memory:');

// Claude reads meaning when a key is set: Haiku for every post past the keyword filter, the large model only when Haiku
// is unsure, and every verdict cached by post and asset. Otherwise the keyword baseline runs, so the replay works offline.
const onError = (error: unknown) => log.append({ kind: 'error', where: 'classifier', message: String(error) });
const classifier: Classifier = process.env.ANTHROPIC_API_KEY
  ? new TieredClassifier({
      small: new ClaudeClassifier({ model: process.env.CLASSIFIER_SMALL_MODEL || SMALL_CLASSIFIER_MODEL, onError }),
      ...(process.env.CLASSIFIER_LARGE_MODEL === 'none'
        ? {}
        : { large: new ClaudeClassifier({ model: process.env.CLASSIFIER_LARGE_MODEL || LARGE_CLASSIFIER_MODEL, onError }) }),
      cache: new VerdictCache(db),
      escalateBelow: Number(process.env.CLASSIFIER_ESCALATE_BELOW || 0.7),
    })
  : new KeywordClassifier();

if (mode === 'replay') {
  const ledger = new CostLedger(db);
  const decisions = new DecisionLog(db);
  const replay = await startReplay({
    profiles,
    log,
    classifier,
    speed: Number(process.env.REPLAY_SPEED || 10),
    onClock: (now) => (agentNow = now),
    decisions,
    costs: ledgerRecorder({ ledger, log }),
  });
  await startConsoleServer({
    log,
    now: replay.now,
    port,
    host,
    allowedOrigins,
    costs: ledger,
    decisions,
    prices: { assets: Object.keys(profiles.assets), latest: (asset) => replay.prices.latest(asset) },
    health: () => ({ ok: true, lastPollAt: replay.now() * 1000, version, mode: 'replay' }),
  });
} else if (mode === 'live') {
  const { startLive } = await import('./live.ts');
  const live = await startLive({ profiles, log, classifier, db, version });
  await startConsoleServer({
    log,
    now: live.now,
    port,
    host,
    allowedOrigins,
    // The website's manual sell takes its Pyth update and the fee from here, so the Hermes key stays on the server
    prices: { assets: Object.keys(profiles.assets), latest: (asset) => live.prices.latest(asset), fee: live.fee },
    tamper: { assets: ['ETH', 'BTC'], build: (asset) => buildTamperSet(profiles, live.prices, asset, live.now()) },
    status: live.status,
    health: live.health,
    costs: live.ledger,
    decisions: live.decisions,
    ...(live.faucet ? { faucet: live.faucet } : {}),
  });
} else {
  throw new Error(`AGENT_MODE must be replay or live, not ${mode}`);
}
console.log(`The Wire Desk: http://${host}:${port}/ (${mode})`);
