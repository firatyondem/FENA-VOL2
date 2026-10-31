// Starts the agent and its console. AGENT_MODE=replay (the default) runs the stage replay without keys or a chain;
// AGENT_MODE=live watches real accounts and talks to the deployed vault.
import { ClaudeClassifier } from './classifier/claude.ts';
import { KeywordClassifier } from './classifier/keyword.ts';
import type { Classifier } from './classifier/types.ts';
import { startConsoleServer } from './console/server.ts';
import { EventLog } from './log.ts';
import { loadProfiles } from './profiles.ts';
import { startReplay } from './replay.ts';

const profiles = loadProfiles();
// Events carry the agent's clock, which the replay runs faster than real time.
let agentNow = () => Math.floor(Date.now() / 1000);
const log = new EventLog({ file: new URL('../.data/events.jsonl', import.meta.url), now: () => agentNow() * 1000 });
const port = Number(process.env.CONSOLE_PORT ?? 4173);
// Pages that may read the explanation log, comma-separated: the frontend shows the AI's reason beside each post
const allowedOrigins = process.env.CONSOLE_ALLOWED_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Claude reads meaning when a key is set; otherwise the keyword baseline runs, so the replay works offline.
const classifier: Classifier = process.env.ANTHROPIC_API_KEY
  ? new ClaudeClassifier({
      model: process.env.CLASSIFIER_MODEL,
      onError: (error) => log.append({ kind: 'error', where: 'classifier', message: String(error) }),
    })
  : new KeywordClassifier();

const mode = process.env.AGENT_MODE ?? 'replay';
if (mode === 'replay') {
  const replay = await startReplay({
    profiles,
    log,
    classifier,
    speed: Number(process.env.REPLAY_SPEED ?? 10),
    onClock: (now) => (agentNow = now),
  });
  await startConsoleServer({ log, now: replay.now, port, allowedOrigins });
} else if (mode === 'live') {
  const { startLive } = await import('./live.ts');
  const live = await startLive({ profiles, log, classifier });
  await startConsoleServer({ log, now: live.now, port, allowedOrigins });
} else {
  throw new Error(`AGENT_MODE must be replay or live, not ${mode}`);
}
console.log(`The Wire Desk: http://127.0.0.1:${port}/ (${mode})`);
