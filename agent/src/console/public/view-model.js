// Turns the explanation log into what the console shows. Pure, so the browser and the tests run the same code.

const byNewest = (a, b) => b.at - a.at || b.seq - a.seq;

// Token amounts carry 18 decimals; four are enough to read, gas amounts need a few more.
export const shortAmount = (text, digits = 4) => {
  const [whole, fraction = ''] = String(text).split('.');
  const kept = fraction.slice(0, digits).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
};

export const buildView = (events) => {
  let meta;
  const posts = new Map();
  const triggers = new Map();
  const ledger = [];
  const tamper = [];
  const notices = [];

  const post = (account, postId) => {
    const key = `${account}:${postId}`;
    if (!posts.has(key)) posts.set(key, { key, account, postId, text: '', at: 0, seq: 0, verdicts: [], skipped: undefined });
    return posts.get(key);
  };

  for (const event of events) {
    switch (event.kind) {
      case 'agent.started':
        meta = event;
        break;
      case 'post.seen':
        Object.assign(post(event.account, event.postId), { text: event.text, createdAt: event.createdAt, at: event.at, seq: event.seq });
        break;
      case 'post.skipped':
        post(event.account, event.postId).skipped = event.reason;
        break;
      case 'post.classified':
        Object.assign(post(event.account, event.postId), { verdicts: event.results, classifier: event.classifier });
        break;
      case 'trigger.opened':
        triggers.set(event.triggerId, { ...event, status: 'waiting', checks: [], outcome: undefined });
        break;
      case 'trigger.checked': {
        const trigger = triggers.get(event.triggerId);
        if (trigger) trigger.checks.push(event);
        break;
      }
      case 'trigger.bought': {
        const trigger = triggers.get(event.triggerId);
        if (trigger) {
          Object.assign(trigger, {
            status: 'bought',
            outcome: `Bought ${shortAmount(event.assetOut)} ${event.asset} for ${event.usdcIn} USDC at ${event.price}`,
          });
        }
        ledger.push({ at: event.at, seq: event.seq, side: 'Buy', asset: event.asset, price: event.price, usdc: event.usdcIn, note: `trigger ${event.triggerId}` });
        break;
      }
      case 'trigger.rejected': {
        const trigger = event.triggerId && triggers.get(event.triggerId);
        if (trigger) Object.assign(trigger, { status: 'rejected', outcome: event.reason });
        else notices.push({ at: event.at, seq: event.seq, text: `${event.asset}: not opened, ${event.reason}` });
        break;
      }
      case 'trigger.expired': {
        const trigger = triggers.get(event.triggerId);
        if (trigger) Object.assign(trigger, { status: 'expired', outcome: 'Window closed without a confirmed trend' });
        break;
      }
      case 'position.sold':
        ledger.push({ at: event.at, seq: event.seq, side: 'Sell', asset: event.asset, price: event.price, usdc: event.usdcOut, note: event.sellKind });
        break;
      case 'tamper.result':
        tamper.push(event);
        break;
      case 'error':
        notices.push({ at: event.at, seq: event.seq, text: `${event.where}: ${event.message}`, error: true });
        break;
      default:
        break;
    }
  }

  const triggerList = [...triggers.values()].sort(byNewest);
  return {
    meta,
    posts: [...posts.values()].sort(byNewest),
    triggers: triggerList,
    ledger: ledger.sort(byNewest),
    tamper,
    notices: notices.sort(byNewest).slice(0, 6),
    counts: {
      posts: posts.size,
      waiting: triggerList.filter((t) => t.status === 'waiting').length,
      bought: triggerList.filter((t) => t.status === 'bought').length,
      refused: triggerList.filter((t) => t.status === 'rejected' || t.status === 'expired').length,
    },
  };
};

// Where `time` falls on a trigger's track from P0 to the window's close, from 0 to 1.
export const trackPosition = (trigger, time) => {
  const span = trigger.closesAt - trigger.t0;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (time - trigger.t0) / span));
};

export const formatBps = (bps) => `${bps >= 0 ? '+' : '−'}${(Math.abs(bps) / 100).toFixed(2)}%`;

// ---- The Engine Room: the agent's heartbeat, wallets, budgets and its last cycles ----

const utcTime = (ms) => new Date(ms).toISOString().slice(11, 19);

// A cycle's colour in the strip: red for an error or a skipped cycle, green for a buy or a sale, amber for a vault
// rejection, blue for a cycle that polled posts, grey for a quiet one
export const cycleTone = (event) => {
  if (event.kind === 'cycle.skipped' || event.errors > 0) return 'red';
  if (event.bought > 0 || event.sold > 0) return 'green';
  if (event.rejected > 0) return 'amber';
  if (event.polled) return 'blue';
  return 'grey';
};

export const cycleTitle = (event) => {
  if (event.kind === 'cycle.skipped') {
    return `Cycle ${event.cycle} skipped: ${event.reason} (${Math.round(event.runningForMs / 1000)} s)`;
  }
  return [
    `Cycle ${event.cycle} · ${utcTime(event.startedAt)} UTC · ${(event.durationMs / 1000).toFixed(1)} s · ${event.mode}`,
    event.polled ? `Polled ${event.accountsPolled.map((handle) => `@${handle}`).join(' ')}` : 'No post poll',
    `${event.postsNew} new posts · ${event.triggersOpened} triggers opened · ${event.p1Checks} P1 checks`,
    `${event.bought} bought · ${event.rejected} rejected · ${event.expired} expired · ${event.sold} sold`,
    `${event.paidCalls} paid calls · ${event.txSent} transactions · ${event.ausdSpent} aUSD · ${shortAmount(event.ethSpent, 8)} ETH`,
    `${event.errors} errors`,
  ].join('\n');
};

const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const share = (used, limit) => {
  const total = Number(limit);
  return total > 0 ? Math.min(100, (Number(used) / total) * 100) : 0;
};

// `status` comes from /api/state and each clock tick; the replay has none, so it has no Engine Room
export const buildEngineRoom = (status, events, stripLength = 60) => {
  if (!status) return undefined;
  const { schedule, budget, wallets, totals } = status;
  const age = schedule.lastCycleAgeSec;
  const staleAfter = 3 * schedule.cycleIntervalSec;
  const heartbeat =
    age === null
      ? { text: 'No cycle yet', stale: status.uptimeSec > staleAfter }
      : { text: `Last cycle ${age} s ago`, stale: age > staleAfter };

  const cards = [
    {
      role: 'Agent wallet',
      purpose: 'Pays the gas of its vault transactions',
      address: wallets.agent.address,
      short: shortAddress(wallets.agent.address),
      link: wallets.agent.link,
      balance: wallets.agent.eth === null ? '—' : `${shortAmount(wallets.agent.eth, 6)} ETH`,
    },
  ];
  if (wallets.payer) {
    cards.push({
      role: 'Payer wallet',
      purpose: 'Pays aUSD for signed data',
      address: wallets.payer.address,
      short: shortAddress(wallets.payer.address),
      link: wallets.payer.link,
      balance: wallets.payer.ausd === null ? '—' : `${shortAmount(wallets.payer.ausd)} aUSD`,
    });
  }

  const bar = (label, spent, limit, unit, digits) => {
    const pct = share(spent, limit);
    return {
      label,
      text: `${shortAmount(spent, digits)} of ${shortAmount(limit, digits)} ${unit} today`,
      pct,
      tone: pct >= 100 ? 'red' : pct >= budget.savingAtPct ? 'amber' : 'ok',
    };
  };
  const budgets = budget
    ? [
        ...(budget.ausd.tracked ? [bar('Data', budget.ausd.spentToday, budget.ausd.limit, 'aUSD', 4)] : []),
        bar('Gas', budget.eth.spentToday, budget.eth.limit, 'ETH', 6),
        {
          label: 'Transactions',
          text: `${budget.txLastHour} of ${budget.maxTxPerHour} in the last hour`,
          pct: share(budget.txLastHour, budget.maxTxPerHour),
          tone: budget.txLastHour >= budget.maxTxPerHour ? 'red' : 'ok',
        },
      ]
    : [];

  const strip = events
    .filter((event) => event.kind === 'cycle.finished' || event.kind === 'cycle.skipped')
    .slice(-stripLength)
    .map((event) => ({ cycle: event.cycle, tone: cycleTone(event), title: cycleTitle(event) }));

  return {
    heartbeat,
    mode: { mode: status.mode, reason: status.modeReason },
    schedule: [
      `One cycle every ${schedule.cycleIntervalSec} s`,
      `posts polled every ${schedule.pollIntervalSec} s`,
      status.watchSet.length > 0 ? `watching ${status.watchSet.map((handle) => `@${handle}`).join(' ')}` : 'no rule, no paid poll',
      schedule.nextAt ? `next cycle ${utcTime(schedule.nextAt)} UTC` : 'next cycle soon',
    ].join(' · '),
    wallets: cards,
    budgets,
    strip,
    totals: [
      ['Cycles', totals.cycles],
      ['Posts', totals.posts],
      ['Triggers', totals.triggers],
      ['Buys', totals.buys],
      ['Sells', totals.sells],
      ['aUSD', shortAmount(totals.ausdSpent)],
      ['ETH', shortAmount(totals.ethSpent, 6)],
      ['Errors recovered', totals.errors],
      ['Restarts', status.restarts],
    ],
  };
};
