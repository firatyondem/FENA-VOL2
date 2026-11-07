// Turns a live run's explanation log into the evidence for the pitch: the run window, what each hour did and spent, every
// transaction the agent's wallet sent, mode changes, failing sources and the settings the run ran with.
// Run with `npm run run-report -- [--since 2h]`. Reads agent/.data/events.jsonl and writes agent/.data/run-report.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { formatEther, parseEther } from 'viem';
import type { LoggedEvent } from '../src/log.ts';

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// "90m", "2h", "1d" in milliseconds
export const parseDuration = (text: string): number => {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(text.trim());
  if (!match) throw new Error(`--since takes a duration such as 30m, 2h or 1d, not "${text}"`);
  return Number(match[1]) * (UNITS[match[2] as string] as number);
};

// One event per line; a torn last line, as after a hard kill, is skipped
export const readEvents = (text: string): LoggedEvent[] =>
  text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as LoggedEvent];
    } catch {
      return [];
    }
  });

// The log keeps every run, replays too; only events of live runs count
export const liveEvents = (events: readonly LoggedEvent[]): LoggedEvent[] => {
  const live: LoggedEvent[] = [];
  let inLive = false;
  for (const event of events) {
    if (event.kind === 'agent.started') inLive = event.mode === 'live';
    if (inLive) live.push(event);
  }
  return live;
};

// With --since, the live events of that window; without, the latest supervised session, from its first start on
export const selectRun = (events: readonly LoggedEvent[], options: { sinceMs?: number; nowMs: number }): LoggedEvent[] => {
  const live = liveEvents(events);
  if (options.sinceMs !== undefined) return live.filter((event) => event.at >= options.nowMs - (options.sinceMs as number));
  const start = live.findLastIndex((event) => event.kind === 'agent.started' && !event.restarts);
  return start < 0 ? live : live.slice(start);
};

export const txLink = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

interface Tally {
  cycles: number;
  polls: number;
  posts: number;
  triggers: number;
  bought: number;
  rejected: Record<string, number>;
  expired: number;
  sold: number;
  // Paid data calls: post fetches and model calls
  payments: number;
  usd: number;
  eth: bigint;
  errors: number;
}

const emptyTally = (): Tally => ({
  cycles: 0,
  polls: 0,
  posts: 0,
  triggers: 0,
  bought: 0,
  rejected: {},
  expired: 0,
  sold: 0,
  payments: 0,
  usd: 0,
  eth: 0n,
  errors: 0,
});

const count = (tally: Tally, event: LoggedEvent) => {
  switch (event.kind) {
    case 'cycle.finished':
      tally.cycles += 1;
      if (event.polled) tally.polls += 1;
      tally.usd += Number(event.costUsd);
      tally.eth += parseEther(event.ethSpent);
      break;
    case 'post.seen':
      tally.posts += 1;
      break;
    case 'trigger.opened':
      tally.triggers += 1;
      break;
    case 'trigger.bought':
      tally.bought += 1;
      break;
    case 'trigger.rejected':
      tally.rejected[event.reason] = (tally.rejected[event.reason] ?? 0) + 1;
      break;
    case 'trigger.expired':
      tally.expired += 1;
      break;
    case 'position.sold':
      tally.sold += 1;
      break;
    case 'cost':
      if (event.costKind === 'post-fetch' || event.costKind === 'ai-call') tally.payments += 1;
      break;
    case 'error':
      tally.errors += 1;
      break;
    default:
      break;
  }
};

export interface Transaction {
  at: number;
  what: string;
  asset: string;
  gasEth?: string;
  hash: string;
}

const transactionOf = (event: LoggedEvent): Transaction | undefined => {
  if (!('txHash' in event) || !event.txHash) return undefined;
  const what =
    event.kind === 'trigger.opened'
      ? `openTrigger #${event.triggerId} (post ${event.postId} @${event.account})`
      : event.kind === 'trigger.bought'
        ? `confirmTrigger #${event.triggerId}, bought position #${event.positionId}`
        : event.kind === 'trigger.expired'
          ? `expireTrigger #${event.triggerId}`
          : event.kind === 'position.sold'
            ? `sell #${event.positionId} (${event.sellKind})`
            : undefined;
  if (!what || !('asset' in event)) return undefined;
  const gas = 'gasEth' in event && event.gasEth ? { gasEth: event.gasEth } : {};
  return { at: event.at, what, asset: event.asset, hash: event.txHash, ...gas };
};

export const buildReport = (events: readonly LoggedEvent[]) => {
  const hours = new Map<string, Tally>();
  const totals = emptyTally();
  const transactions: Transaction[] = [];
  const modes: { at: number; mode: string; reason: string }[] = [];
  const sources: { at: number; text: string }[] = [];
  const recovered: { at: number; openTriggers: string[] }[] = [];
  let settings: Record<string, string | number> | undefined;
  let restarts = 0;
  let skipped = 0;
  let uptimeMs = 0;
  let segmentStart: number | undefined;
  let previous: number | undefined;

  for (const event of events) {
    if (event.kind === 'agent.started') {
      if (segmentStart !== undefined && previous !== undefined) uptimeMs += previous - segmentStart;
      segmentStart = event.at;
      if (event.restarts) restarts += 1;
      if (event.settings) settings = event.settings;
    }
    segmentStart ??= event.at;
    previous = event.at;

    const hour = `${new Date(event.at).toISOString().slice(0, 13)}:00`;
    if (!hours.has(hour)) hours.set(hour, emptyTally());
    count(hours.get(hour) as Tally, event);
    count(totals, event);

    const transaction = transactionOf(event);
    if (transaction) transactions.push(transaction);
    if (event.kind === 'cycle.skipped') skipped += 1;
    if (event.kind === 'budget.mode') modes.push({ at: event.at, mode: event.mode, reason: event.reason });
    if (event.kind === 'source.degraded') {
      const retry = new Date(event.retryAt).toISOString().slice(11, 19);
      sources.push({ at: event.at, text: `${event.source} degraded after ${event.failures} failures in a row, next try ${retry} UTC` });
    }
    if (event.kind === 'source.recovered') sources.push({ at: event.at, text: `${event.source} recovered` });
    if (event.kind === 'agent.recovered') recovered.push({ at: event.at, openTriggers: event.openTriggers });
  }
  if (segmentStart !== undefined && previous !== undefined) uptimeMs += previous - segmentStart;

  return {
    from: events[0]?.at,
    to: events.at(-1)?.at,
    uptimeMs,
    restarts,
    cyclesRun: totals.cycles,
    cyclesSkipped: skipped,
    hours: [...hours].map(([hour, tally]) => ({ hour, ...tally })),
    totals,
    transactions,
    modes,
    sources,
    recovered,
    settings,
  };
};

export type RunReport = ReturnType<typeof buildReport>;

const time = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};
const usd = (value: number) => `$${value.toFixed(4)}`;
const rejections = (rejected: Record<string, number>) =>
  Object.entries(rejected)
    .map(([reason, times]) => `${reason} ×${times}`)
    .join(', ') || '—';
const sum = (rejected: Record<string, number>) => Object.values(rejected).reduce((total, times) => total + times, 0);

export const renderSummary = (report: RunReport): string => {
  if (report.from === undefined || report.to === undefined) return 'No live run in the log for this window.';
  const { totals } = report;
  const spent = `spent ${usd(totals.usd)} and ${formatEther(totals.eth)} ETH`;
  return [
    `Run ${time(report.from)} → ${time(report.to)}: up ${duration(report.uptimeMs)}, ${report.restarts} restart(s)`,
    `${report.cyclesRun} cycles (${report.cyclesSkipped} skipped), ${totals.polls} polls, ${totals.posts} new posts`,
    `${totals.triggers} triggers opened, ${totals.bought} bought, ${sum(totals.rejected)} rejected, ` +
      `${totals.expired} expired, ${totals.sold} sold`,
    `${report.transactions.length} agent transactions, ${totals.payments} data payments; ${spent}`,
    `${totals.errors} errors logged; ${report.modes.length} mode change(s), ${report.sources.length} source event(s)`,
  ].join('\n');
};

export const renderMarkdown = (report: RunReport): string => {
  if (report.from === undefined || report.to === undefined) {
    return '# Run report\n\nNo live run in the log for this window.\n';
  }
  const lines = ['# Run report', '', '## The run', ''];
  lines.push(
    `- Window: ${time(report.from)} → ${time(report.to)}`,
    `- Uptime: ${duration(report.uptimeMs)}, restarts: ${report.restarts}`,
    `- Cycles run: ${report.cyclesRun}, skipped: ${report.cyclesSkipped}`,
    `- Agent transactions: ${report.transactions.length}, data payments: ${report.totals.payments}`,
    `- Spent: ${usd(report.totals.usd)} on data and fees, ${formatEther(report.totals.eth)} ETH on gas`,
    `- Errors logged: ${report.totals.errors}`
  );
  for (const restore of report.recovered) {
    const ids = restore.openTriggers.map((id) => `#${id}`).join(', ');
    lines.push(`- ${time(restore.at)}: restart recovered ${restore.openTriggers.length} open trigger(s)${ids ? ` (${ids})` : ''}`);
  }

  lines.push('', '## Per hour', '');
  lines.push('| Hour (UTC) | Cycles | Polls | Posts | Opened | Bought | Rejected | Expired | Sold | USD | ETH | Errors |');
  lines.push('| --- | --: | --: | --: | --: | --: | --- | --: | --: | --: | --: | --: |');
  for (const hour of report.hours) {
    const cells = [hour.hour, hour.cycles, hour.polls, hour.posts, hour.triggers, hour.bought, rejections(hour.rejected)];
    cells.push(hour.expired, hour.sold, usd(hour.usd), formatEther(hour.eth), hour.errors);
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push('', '## Agent transactions', '');
  if (report.transactions.length === 0) lines.push('None in this window.');
  else {
    lines.push('| Time (UTC) | What | Asset | Gas (ETH) | Transaction |', '| --- | --- | --- | --: | --- |');
    for (const tx of report.transactions) {
      lines.push(`| ${time(tx.at)} | ${tx.what} | ${tx.asset} | ${tx.gasEth ?? '—'} | [${tx.hash.slice(0, 10)}…](${txLink(tx.hash)}) |`);
    }
  }

  lines.push('', '## Mode changes', '');
  if (report.modes.length === 0) lines.push('None.');
  for (const change of report.modes) lines.push(`- ${time(change.at)}: **${change.mode}**: ${change.reason}`);

  lines.push('', '## Sources', '');
  if (report.sources.length === 0) lines.push('No source backed off.');
  for (const source of report.sources) lines.push(`- ${time(source.at)}: ${source.text}`);

  lines.push('', '## Settings', '');
  if (!report.settings) lines.push('Not recorded by this run.');
  else for (const [name, value] of Object.entries(report.settings)) lines.push(`- ${name}: ${value}`);
  return `${lines.join('\n')}\n`;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sinceIndex = args.indexOf('--since');
  const sinceMs = sinceIndex >= 0 ? parseDuration(args[sinceIndex + 1] ?? '') : undefined;
  const events = readEvents(readFileSync(new URL('../.data/events.jsonl', import.meta.url), 'utf8'));
  const report = buildReport(selectRun(events, { nowMs: Date.now(), ...(sinceMs === undefined ? {} : { sinceMs }) }));
  writeFileSync(new URL('../.data/run-report.md', import.meta.url), renderMarkdown(report));
  console.log(renderSummary(report));
  console.log('Wrote agent/.data/run-report.md');
}
