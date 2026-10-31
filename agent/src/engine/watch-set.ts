// The accounts worth a paid poll: those that at least one unpaused rule naming this agent watches for one of its assets.
// No rule, no paid call.
import type { Rule } from '../chain/vault.ts';
import type { WatchedAccount } from '../sources/twitter.ts';

// Handles, sorted. A rule's accounts map each handle to the rule's assets linked to it; an empty list buys nothing.
export const activeWatchSet = (rules: readonly Rule[]): string[] => {
  const handles = new Set<string>();
  for (const rule of rules) {
    if (rule.paused) continue;
    for (const [handle, assets] of Object.entries(rule.accounts)) if (assets.length > 0) handles.add(handle);
  }
  return [...handles].sort();
};

export const watchedAccountsIn = (watchlist: readonly WatchedAccount[], handles: readonly string[]): WatchedAccount[] =>
  watchlist.filter((account) => handles.includes(account.handle));
