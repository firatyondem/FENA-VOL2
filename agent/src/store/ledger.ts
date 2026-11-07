// The cost ledger: one row per paid action and user it served. A poll that serves several users is split evenly, so
// each user's day adds up to what the agent actually spent on them. GET /api/costs reads it.
import { type Db, utcDate } from './db.ts';

export type CostKind = 'post-fetch' | 'ai-call' | 'price-update-fee' | 'gas';

export interface CostEntry {
  kind: CostKind;
  // getxapi, twitterapi.io, claude-haiku-5-5, pyth, base-sepolia, ...
  source: string;
  // The users it served; none means it served nobody in particular (the cost still counts in the total)
  users: readonly string[];
  // Calls, tokens, updates or gas units, in total
  units: number;
  usd: number;
  // For gas and Pyth's fee
  wei?: bigint;
  ref?: string;
  // Milliseconds since the epoch
  at?: number;
}

export interface CostDay {
  date: string;
  posts: number;
  aiCalls: number;
  priceUpdates: number;
  gasWei: string;
  totalUsd: number;
  bySource: Record<string, { kind: CostKind; units: number; usd: number }>;
}

export interface CostReport {
  user: string;
  days: CostDay[];
  totalUsd: number;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

export class CostLedger {
  private readonly db: Db;
  private readonly nowMs: () => number;

  constructor(db: Db, nowMs: () => number = Date.now) {
    this.db = db;
    this.nowMs = nowMs;
  }

  record(entry: CostEntry): void {
    const users = entry.users.length > 0 ? [...new Set(entry.users.map((user) => user.toLowerCase()))] : [''];
    const share = users.length;
    const wei = entry.wei ?? 0n;
    const insert = this.db.prepare(
      'INSERT INTO ledger (at, user, kind, source, units, usd, wei, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    users.forEach((user, index) => {
      // The wei that does not divide evenly goes to the first user, so the shares add up exactly
      const weiShare = wei / BigInt(share) + (index === 0 ? wei % BigInt(share) : 0n);
      insert.run(
        entry.at ?? this.nowMs(),
        user,
        entry.kind,
        entry.source,
        entry.units / share,
        entry.usd / share,
        weiShare.toString(),
        entry.ref ?? null
      );
    });
  }

  // USD spent since the start of the UTC day on `kinds`, for every user together
  usdToday(kinds: readonly CostKind[] = ['post-fetch', 'ai-call']): number {
    const start = Date.parse(`${utcDate(this.nowMs())}T00:00:00Z`);
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM ledger WHERE at >= ? AND kind IN (${kinds.map(() => '?').join(', ')})`)
      .get(start, ...kinds) as { usd: number };
    return row.usd;
  }

  // Per UTC day, newest last, for one user or (user = '*') for everything; days without a cost are listed too
  report(user: string, days = 7): CostReport {
    const key = user.toLowerCase();
    const end = this.nowMs();
    const start = Date.parse(`${utcDate(end - (days - 1) * 86_400_000)}T00:00:00Z`);
    const rows = this.db
      .prepare(
        `SELECT at, kind, source, units, usd, wei FROM ledger WHERE at >= ? ${key === '*' ? '' : 'AND user = ?'} ORDER BY at`
      )
      .all(...(key === '*' ? [start] : [start, key])) as {
      at: number;
      kind: CostKind;
      source: string;
      units: number;
      usd: number;
      wei: string;
    }[];
    const byDate = new Map<string, CostDay & { gas: bigint }>();
    for (let i = 0; i < days; i++) {
      const date = utcDate(start + i * 86_400_000);
      byDate.set(date, { date, posts: 0, aiCalls: 0, priceUpdates: 0, gasWei: '0', gas: 0n, totalUsd: 0, bySource: {} });
    }
    for (const row of rows) {
      const day = byDate.get(utcDate(row.at));
      if (!day) continue;
      if (row.kind === 'post-fetch') day.posts += row.units;
      if (row.kind === 'ai-call') day.aiCalls += 1;
      if (row.kind === 'price-update-fee') day.priceUpdates += row.units;
      if (row.kind === 'gas') day.gas += BigInt(row.wei);
      day.totalUsd += row.usd;
      const source = (day.bySource[row.source] ??= { kind: row.kind, units: 0, usd: 0 });
      source.units += row.units;
      source.usd += row.usd;
    }
    const list = [...byDate.values()].map(({ gas, ...day }) => ({
      ...day,
      posts: round(day.posts),
      priceUpdates: round(day.priceUpdates),
      gasWei: gas.toString(),
      totalUsd: round(day.totalUsd),
      bySource: Object.fromEntries(
        Object.entries(day.bySource).map(([name, source]) => [name, { ...source, units: round(source.units), usd: round(source.usd) }])
      ),
    }));
    return { user: key, days: list, totalUsd: round(list.reduce((sum, day) => sum + day.totalUsd, 0)) };
  }
}
