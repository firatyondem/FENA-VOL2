// The accounts the agent can read: agent/config/watchlist.json, plus our demo account when DEMO_X_HANDLE is set.
import { readFileSync } from 'node:fs';
import type { WatchedAccount } from './twitter.ts';

export const WATCHLIST_URL = new URL('../../config/watchlist.json', import.meta.url);

export const loadWatchlist = (env: NodeJS.ProcessEnv = process.env, url: URL = WATCHLIST_URL): WatchedAccount[] => {
  const watchlist = JSON.parse(readFileSync(url, 'utf8')) as WatchedAccount[];
  if (env.DEMO_X_HANDLE) {
    // Our own account for the live stage post, linked like Trump's (spec: our demo account)
    watchlist.push({ handle: env.DEMO_X_HANDLE, label: 'Demo account', assets: ['OIL', 'BTC', 'ETH'], pinned: false });
  }
  return watchlist;
};
