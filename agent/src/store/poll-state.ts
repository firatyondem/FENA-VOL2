// Per watched account: the newest post ID seen (the next poll asks only for newer ones), when it was last polled and
// when it last posted. Kept in the database, so a restart neither re-reads old posts nor forgets a quiet account.
import type { Db } from './db.ts';

export interface PollState {
  sinceId?: string;
  // Milliseconds
  lastPollAt?: number;
  // Seconds
  lastPostAt?: number;
}

export class PollStateStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(handle: string): PollState {
    const row = this.db
      .prepare('SELECT since_id, last_poll_at, last_post_at FROM poll_state WHERE handle = ?')
      .get(handle.toLowerCase()) as { since_id: string | null; last_poll_at: number | null; last_post_at: number | null } | undefined;
    return {
      ...(row?.since_id ? { sinceId: row.since_id } : {}),
      ...(row?.last_poll_at ? { lastPollAt: row.last_poll_at } : {}),
      ...(row?.last_post_at ? { lastPostAt: row.last_post_at } : {}),
    };
  }

  set(handle: string, update: PollState): void {
    const next = { ...this.get(handle), ...update };
    this.db
      .prepare(
        `INSERT INTO poll_state (handle, since_id, last_poll_at, last_post_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (handle) DO UPDATE SET since_id = excluded.since_id, last_poll_at = excluded.last_poll_at,
         last_post_at = excluded.last_post_at`
      )
      .run(handle.toLowerCase(), next.sinceId ?? null, next.lastPollAt ?? null, next.lastPostAt ?? null);
  }
}
