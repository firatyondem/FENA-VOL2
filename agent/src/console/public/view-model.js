// Turns the explanation log into what the console shows. Pure, so the browser and the tests run the same code.

const byNewest = (a, b) => b.at - a.at || b.seq - a.seq;

// Token amounts carry 18 decimals; four are enough to read.
export const shortAmount = (text) => {
  const [whole, fraction = ''] = String(text).split('.');
  const kept = fraction.slice(0, 4).replace(/0+$/, '');
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
