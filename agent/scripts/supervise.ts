// Keeps the live agent running unattended: starts it as a child process, restarts it after a crash with a growing backoff,
// and stops for good on Ctrl+C. No pm2 and no new dependency; it runs the same in Git Bash on Windows and on Linux.
// Run with `npm run live:supervised`.
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 5 s, 10 s, 20 s, then 60 s between restarts in a row
export const BACKOFF_MS = [5_000, 10_000, 20_000, 60_000] as const;
// A run this long was healthy, so the next crash starts the backoff over
export const STABLE_UPTIME_MS = 10 * 60_000;
export const MAX_RESTARTS_PER_HOUR = 20;

export type Decision =
  | { action: 'stop' }
  | { action: 'restart'; delayMs: number; restarts: number }
  | { action: 'give-up'; reason: string };

export interface ChildExit {
  // null when a signal ended the child, as `kill <pid>` does on Linux
  code: number | null;
  // Set once the user pressed Ctrl+C: whatever the child exits with, that is a stop
  stopping: boolean;
  uptimeMs: number;
  nowMs: number;
}

// Decides what follows each exit of the agent; pure, so the timing is tested without waiting for it
export class RestartPolicy {
  private consecutive = 0;
  private readonly restartTimes: number[] = [];
  private total = 0;

  get restarts(): number {
    return this.total;
  }

  onExit({ code, stopping, uptimeMs, nowMs }: ChildExit): Decision {
    if (stopping || code === 0) return { action: 'stop' };
    if (uptimeMs >= STABLE_UPTIME_MS) this.consecutive = 0;
    const hourAgo = nowMs - 3_600_000;
    while (this.restartTimes.length > 0 && (this.restartTimes[0] ?? 0) <= hourAgo) this.restartTimes.shift();
    if (this.restartTimes.length >= MAX_RESTARTS_PER_HOUR) {
      return { action: 'give-up', reason: `${MAX_RESTARTS_PER_HOUR} restarts in the last hour` };
    }
    const delayMs = BACKOFF_MS[Math.min(this.consecutive, BACKOFF_MS.length - 1)] ?? 60_000;
    this.consecutive += 1;
    this.restartTimes.push(nowMs);
    this.total += 1;
    return { action: 'restart', delayMs, restarts: this.total };
  }
}

if (import.meta.main) {
  const agentDir = fileURLToPath(new URL('..', import.meta.url));
  const policy = new RestartPolicy();
  let child: ChildProcess | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const say = (message: string) => console.log(`[supervisor ${new Date().toISOString()}] ${message}`);

  const start = () => {
    const startedAt = Date.now();
    child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/main.ts'], {
      cwd: agentDir,
      stdio: 'inherit',
      // The child logs the count in agent.started
      env: { ...process.env, AGENT_MODE: 'live', AGENT_RESTARTS: String(policy.restarts) },
    });
    say(`agent started, pid ${child.pid} (restarts so far: ${policy.restarts})`);
    child.on('exit', (code, signal) => {
      child = undefined;
      const uptimeMs = Date.now() - startedAt;
      const decision = policy.onExit({ code, stopping, uptimeMs, nowMs: Date.now() });
      const how = signal ? `signal ${signal}` : `code ${code}`;
      if (decision.action === 'stop') {
        say(`agent stopped (${how}); not restarting`);
        process.exit(0);
      }
      if (decision.action === 'give-up') {
        console.error(`[supervisor] GIVING UP: ${decision.reason}. The agent is NOT running. Last exit: ${how}.`);
        process.exit(1);
      }
      say(`agent exited (${how}) after ${Math.round(uptimeMs / 1000)} s; restart ${decision.restarts} in ${decision.delayMs / 1000} s`);
      restartTimer = setTimeout(start, decision.delayMs);
    });
  };

  // Ctrl+C is a clean stop: the child stops and is not restarted. A second Ctrl+C stops it the hard way.
  const stop = () => {
    if (stopping) {
      child?.kill('SIGKILL');
      process.exit(130);
    }
    stopping = true;
    say('Ctrl+C: stopping the agent, no restart');
    if (restartTimer) clearTimeout(restartTimer);
    if (!child) process.exit(0);
    child.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  start();
}
