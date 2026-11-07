// Smart polling: each watched account is polled often while its posts can move a market (US market hours, or right after
// it posted) and rarely when nothing happens (at night, after a long quiet spell). A poll serves every rule that watches
// the account, so the schedule decides the post bill on its own.

export interface PollScheduleSettings {
  // During market hours, or within `hotAfterPostSec` after the account posted
  activeSec: number;
  // Outside market hours
  quietSec: number;
  // Outside market hours, once the account has not posted for `idleAfterSec`
  idleSec: number;
  hotAfterPostSec: number;
  idleAfterSec: number;
  // Market hours in `timeZone`, on weekdays: "HH:MM-HH:MM"
  marketHours: string;
  timeZone: string;
}

export const DEFAULT_POLL_SCHEDULE: PollScheduleSettings = {
  activeSec: 60,
  quietSec: 600,
  idleSec: 900,
  hotAfterPostSec: 1800,
  idleAfterSec: 6 * 3600,
  marketHours: '09:30-16:00',
  timeZone: 'America/New_York',
};

export const readPollSchedule = (env: NodeJS.ProcessEnv = process.env): PollScheduleSettings => {
  const number = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);
  const d = DEFAULT_POLL_SCHEDULE;
  return {
    activeSec: number('POLL_ACTIVE_SEC', number('POLL_INTERVAL_SEC', d.activeSec)),
    quietSec: number('POLL_QUIET_SEC', d.quietSec),
    idleSec: number('POLL_IDLE_SEC', d.idleSec),
    hotAfterPostSec: number('POLL_HOT_AFTER_POST_SEC', d.hotAfterPostSec),
    idleAfterSec: number('POLL_IDLE_AFTER_SEC', d.idleAfterSec),
    marketHours: env.POLL_MARKET_HOURS || d.marketHours,
    timeZone: env.POLL_TIME_ZONE || d.timeZone,
  };
};

const minutesOf = (hhmm: string) => {
  const [hours = '0', minutes = '0'] = hhmm.split(':');
  return Number(hours) * 60 + Number(minutes);
};

// Whether `ms` falls in market hours on a weekday, in the schedule's time zone
export const inMarketHours = (ms: number, settings: Pick<PollScheduleSettings, 'marketHours' | 'timeZone'>) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: settings.timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value])
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const [open = '00:00', close = '00:00'] = settings.marketHours.split('-');
  return now >= minutesOf(open) && now < minutesOf(close);
};

export interface AccountActivity {
  // Milliseconds
  lastPollAt?: number;
  // Seconds
  lastPostAt?: number;
}

// Seconds between two polls of an account now
export const pollIntervalSec = (settings: PollScheduleSettings, nowMs: number, activity: AccountActivity): number => {
  const sincePost = activity.lastPostAt === undefined ? Infinity : nowMs / 1000 - activity.lastPostAt;
  if (sincePost <= settings.hotAfterPostSec || inMarketHours(nowMs, settings)) return settings.activeSec;
  return sincePost >= settings.idleAfterSec ? settings.idleSec : settings.quietSec;
};

export const isPollDue = (settings: PollScheduleSettings, nowMs: number, activity: AccountActivity) =>
  activity.lastPollAt === undefined || nowMs - activity.lastPollAt >= pollIntervalSec(settings, nowMs, activity) * 1000;
