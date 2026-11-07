// The agent's one database file: the cost ledger, the decision log, the classifier's verdict cache, the poll state and
// the faucet's limits. SQLite in one file, so a host only needs a small persistent volume. Uses Node's built-in
// node:sqlite, so there is no native dependency to build.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,          -- milliseconds since the epoch
  user TEXT NOT NULL,           -- lower-case address, '' when the cost served no user
  kind TEXT NOT NULL,           -- post-fetch | ai-call | price-update-fee | gas
  source TEXT NOT NULL,         -- getxapi, claude-haiku-5-5, pyth, base-sepolia, ...
  units REAL NOT NULL,          -- calls, tokens, updates or gas, this user's share
  usd REAL NOT NULL,            -- this user's share
  wei TEXT NOT NULL DEFAULT '0',-- for gas and Pyth fees, this user's share
  ref TEXT                      -- a post ID, transaction hash or asset
);
CREATE INDEX IF NOT EXISTS ledger_user_at ON ledger (user, at);

CREATE TABLE IF NOT EXISTS decisions (
  tweet_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,  -- seconds
  seen_at INTEGER NOT NULL,     -- milliseconds
  verdict TEXT NOT NULL,        -- relevant | not-relevant | skipped-by-filter | pending
  reason TEXT NOT NULL,
  classifier TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decision_users (
  tweet_id TEXT NOT NULL,
  user TEXT NOT NULL,
  PRIMARY KEY (tweet_id, user)
);
CREATE TABLE IF NOT EXISTS decision_assets (
  id INTEGER PRIMARY KEY,
  tweet_id TEXT NOT NULL,
  user TEXT NOT NULL,
  asset TEXT NOT NULL,
  gate INTEGER NOT NULL,        -- 1 opens the price check, 2 buys
  outcome TEXT NOT NULL,        -- opened | bought | expired | the vault's error name
  tx_hash TEXT,
  trigger_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_assets_tweet ON decision_assets (tweet_id);
CREATE INDEX IF NOT EXISTS decision_assets_trigger ON decision_assets (trigger_id);

CREATE TABLE IF NOT EXISTS verdicts (
  tweet_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  relevant INTEGER NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (tweet_id, asset)
);

CREATE TABLE IF NOT EXISTS poll_state (
  handle TEXT PRIMARY KEY,
  since_id TEXT,
  last_poll_at INTEGER,         -- milliseconds
  last_post_at INTEGER          -- seconds
);

CREATE TABLE IF NOT EXISTS faucet (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  day TEXT NOT NULL,            -- UTC date
  at INTEGER NOT NULL,
  eth_tx TEXT,
  usdc_tx TEXT
);
CREATE INDEX IF NOT EXISTS faucet_day ON faucet (day, address);
`;

// ':memory:' for tests; a file path or URL otherwise, with its directory created
export const openDb = (location: string | URL = ':memory:'): Db => {
  const path = location instanceof URL ? fileURLToPath(location) : location;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
};

export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
