// Renders the explanation log. Post text is untrusted, so every value goes in through textContent, never as HTML.
import { buildView, formatBps, trackPosition } from './view-model.js';

const events = [];
let agentNow = Math.floor(Date.now() / 1000);

const $ = (id) => document.getElementById(id);
const clockTime = (seconds) => new Date(seconds * 1000).toISOString().slice(11, 19);
const eventTime = (ms) => clockTime(Math.floor(ms / 1000));

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const fromTemplate = (id) => $(id).content.firstElementChild.cloneNode(true);

const renderFacts = (meta) => {
  const facts = $('facts');
  facts.replaceChildren();
  if (!meta) return;
  const rows = [
    ['Mode', meta.mode],
    ['Vault', meta.vault],
    ['Classifier', meta.classifier],
    ['Watching', meta.accounts.map((handle) => `@${handle}`).join('  ')],
  ];
  for (const [term, value] of rows) {
    const row = el('div');
    row.append(el('dt', '', term), el('dd', '', value));
    facts.append(row);
  }
  $('edition').textContent = meta.mode === 'replay' ? 'Replay edition · signed fixtures' : 'Live edition · Base Sepolia';
};

const renderTally = (counts) => {
  const items = [
    ['Posts read', counts.posts],
    ['Waiting', counts.waiting],
    ['Bought', counts.bought],
    ['Refused', counts.refused],
  ];
  $('tally').replaceChildren(
    ...items.map(([label, value]) => {
      const item = el('li');
      item.append(el('strong', '', String(value)), el('span', '', label));
      return item;
    })
  );
};

const renderNotices = (notices) => {
  $('notices').replaceChildren(
    ...notices.map((notice) => {
      const line = el('p', '', `${eventTime(notice.at)}  ${notice.text}`);
      if (notice.error) line.dataset.error = '';
      return line;
    })
  );
};

const renderPost = (post) => {
  const node = fromTemplate('post-template');
  const time = node.querySelector('.post__time');
  time.textContent = post.createdAt ? clockTime(post.createdAt) : '';
  if (post.createdAt) time.dateTime = new Date(post.createdAt * 1000).toISOString();
  node.querySelector('.post__account').textContent = `@${post.account}`;
  node.querySelector('.post__text').textContent = post.text;
  const verdicts = node.querySelector('.verdicts');
  if (post.skipped) {
    verdicts.append(el('li', 'verdict verdict--skipped', `Set aside: ${post.skipped}`));
  }
  for (const verdict of post.verdicts) {
    const row = el('li', 'verdict');
    row.dataset.relevant = String(verdict.relevant);
    row.append(
      el('span', 'verdict__asset', verdict.relevant ? `→ ${verdict.asset}` : verdict.asset),
      el('span', '', verdict.confidence.toFixed(2)),
      el('span', 'verdict__reason', verdict.reason)
    );
    verdicts.append(row);
  }
  return node;
};

const STAMPS = { waiting: 'Waiting', bought: 'Bought', rejected: 'Refused', expired: 'Expired' };

const renderTrigger = (trigger) => {
  const node = fromTemplate('trigger-template');
  node.querySelector('.trigger__no').textContent = `No. ${trigger.triggerId}`;
  node.querySelector('.trigger__asset').textContent = trigger.asset;
  node.querySelector('.trigger__via').textContent = `via @${trigger.account} · rule ${trigger.ruleId}`;
  const stamp = node.querySelector('.stamp');
  stamp.textContent = STAMPS[trigger.status];
  stamp.dataset.status = trigger.status;

  node.querySelector('.gate__body--one').textContent =
    `Signed post ${trigger.postId.slice(-8)} verified · P0 ${trigger.p0} at ${clockTime(trigger.t0)}`;

  const track = node.querySelector('.track');
  const opens = trackPosition(trigger, trigger.opensAt) * 100;
  const eligible = node.querySelector('.track__eligible');
  eligible.style.left = `${opens}%`;
  eligible.style.right = '0';
  const now = node.querySelector('.track__now');
  now.style.left = `${trackPosition(trigger, agentNow) * 100}%`;
  now.hidden = trigger.status !== 'waiting';
  track.setAttribute('aria-label', `Window opens ${clockTime(trigger.opensAt)}, closes ${clockTime(trigger.closesAt)}`);
  node.querySelector('.track__start').textContent = `P0 ${clockTime(trigger.t0)}`;
  node.querySelector('.track__opens').textContent = `opens ${clockTime(trigger.opensAt)}`;
  node.querySelector('.track__closes').textContent = `closes ${clockTime(trigger.closesAt)}`;

  const last = trigger.checks.at(-1);
  const scale = node.querySelector('.scale');
  const cap = trigger.spikeCapBps;
  node.querySelector('.scale__threshold').style.left = `${(trigger.thresholdBps / cap) * 100}%`;
  const mark = node.querySelector('.scale__mark');
  if (last) {
    const clamped = Math.min(cap, Math.max(0, last.changeBps));
    mark.style.left = `${(clamped / cap) * 100}%`;
    scale.dataset.state = last.changeBps > cap ? 'over' : last.changeBps >= trigger.thresholdBps ? 'pass' : 'under';
  } else {
    mark.hidden = true;
  }
  scale.setAttribute(
    'aria-label',
    `Threshold ${formatBps(trigger.thresholdBps)}, spike cap ${formatBps(cap)}${last ? `, last move ${formatBps(last.changeBps)}` : ''}`
  );
  node.querySelector('.scale__legend').textContent = last
    ? `P1 ${last.p1}  ${formatBps(last.changeBps)}  ·  needs ${formatBps(trigger.thresholdBps)}, cap ${formatBps(cap)}`
    : `needs ${formatBps(trigger.thresholdBps)}, cap ${formatBps(cap)}  ·  no P1 yet`;

  node.querySelector('.trigger__outcome').textContent =
    trigger.outcome ?? (last ? `Last check: ${last.verdict}` : 'Waiting for the window to open');
  return node;
};

const renderLedger = (rows) => {
  $('ledger').tBodies[0].replaceChildren(
    ...rows.map((row) => {
      const tr = el('tr');
      const side = el('td', '', row.side);
      side.dataset.side = row.side;
      tr.append(
        el('td', '', eventTime(row.at)),
        side,
        el('td', '', `${row.asset}${row.note ? ` · ${row.note}` : ''}`),
        el('td', 'num', row.price),
        el('td', 'num', row.usdc)
      );
      return tr;
    })
  );
  $('ledger-empty').hidden = rows.length > 0;
};

const renderTamper = (results) => {
  $('tamper').tBodies[0].replaceChildren(
    ...results.map((result) => {
      const tr = el('tr');
      const test = el('td');
      test.append(el('span', 'tamper__name', result.name), el('span', 'tamper__expected', result.expected));
      const verdict = el('td', '', result.passed ? '✓' : '✗');
      verdict.dataset.passed = String(result.passed);
      verdict.title = result.passed ? 'Refused as expected' : 'Not refused as expected';
      tr.append(test, el('td', '', result.actual), verdict);
      return tr;
    })
  );
  $('tamper-empty').hidden = results.length > 0;
};

const render = () => {
  const view = buildView(events);
  renderFacts(view.meta);
  renderTally(view.counts);
  renderNotices(view.notices);
  $('wire').replaceChildren(...view.posts.slice(0, 40).map(renderPost));
  $('wire-empty').hidden = view.posts.length > 0;
  $('gates').replaceChildren(...view.triggers.slice(0, 20).map(renderTrigger));
  $('gates-empty').hidden = view.triggers.length > 0;
  renderLedger(view.ledger);
  renderTamper(view.tamper);
  $('clock').textContent = `${clockTime(agentNow)} UTC`;
};

let scheduled = false;
const scheduleRender = () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
};

const setLive = (state, text) => {
  $('live').dataset.state = state;
  $('live-text').textContent = text;
};

const connect = async () => {
  const state = await fetch('/api/state').then((response) => response.json());
  events.splice(0, events.length, ...state.events);
  agentNow = state.now;
  render();

  const stream = new EventSource(`/api/stream?since=${state.events.at(-1)?.seq ?? 0}`);
  stream.addEventListener('open', () => setLive('open', 'Live'));
  stream.addEventListener('error', () => setLive('closed', 'Reconnecting'));
  // The agent restarted while this page stayed open: its events start over, so load them afresh
  stream.addEventListener('hello', (message) => {
    if (JSON.parse(message.data).runId === state.runId) return;
    stream.close();
    connect().catch(() => setLive('closed', 'Offline'));
  });
  stream.addEventListener('agent-event', (message) => {
    const event = JSON.parse(message.data);
    if (!events.some((known) => known.seq === event.seq)) events.push(event);
    scheduleRender();
  });
  stream.addEventListener('clock', (message) => {
    agentNow = JSON.parse(message.data).now;
    scheduleRender();
  });
};

connect().catch((error) => {
  setLive('closed', 'Offline');
  console.error(error);
});
