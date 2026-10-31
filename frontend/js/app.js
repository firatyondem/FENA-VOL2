// ===== UI logic =====
// Everything the page does lives here. It talks to `Mock` (practice mode) for now;
// once the contract is deployed, swap the Mock.* calls for contract calls (marked TODO).

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPrice = n => fmt(n, n < 1 ? 4 : 2);
const fmtSigned = n => (n >= 0 ? "+" : "−") + fmt(Math.abs(n));
const fmtMin = m => m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} h`;
const clock = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateTime = ts => new Date(ts).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const accountOf = handle => ACCOUNTS.find(a => a.handle === handle);
const shortName = handle => accountOf(handle).name.split(" ").pop();
const token = a => ASSETS[a].token;
const assetName = a => ASSETS[a].label.replace(/ \(.*\)/, "").toLowerCase();

// Plain-English sentence for each contract refusal
const REASONS = {
  InvalidSignature: "the signature doesn't match the data (a value was edited)",
  UnexpectedSigner: "it was signed by a key that isn't the expected Airnode",
  WrongRequestHash: "the response belongs to a different request",
  ResponseTooOld: "the response is too old",
  ResponseAlreadyUsed: "this exact response was already used",
  TooEarly: "the minimum wait isn't over yet; the check stays open",
  TriggerExpired: "the time window passed; nothing was invested",
  SpikeCapExceeded: "the price rose more than your maximum rise",
  TrendNotMet: "the price didn't rise enough",
  MarketClosed: "the market is closed",
  CooldownActive: "the pause between investments is still running",
  MaxPerTradeExceeded: "the amount is above your max per investment",
  DailyLimitReached: "your daily limit is reached",
  AssetBudgetUsedUp: "this asset's share of today's budget is used up",
  InsufficientVaultBalance: "there isn't enough mUSDC in the vault",
  RulePaused: "your rule is paused",
  NoRule: "no rule is set",
  AccountNotWatched: "this account isn't watched by your rule",
  AssetNotInRule: "this asset isn't in your rule",
  AssetNotLinkedToAccount: "this asset isn't linked to this account",
  PostAlreadyUsed: "this post already started an investment",
  PositionAlreadySold: "the position is already sold",
  ZeroAmount: "enter an amount above 0",
  // The deployed vault's custom errors (live mode)
  InsufficientBalance: "there isn't enough mUSDC for that",
  InvalidRule: "the rule breaks one of the vault's checks",
  RuleLooserThanProfile: "a value is looser than the asset's profile allows",
  AccountNotRegistered: "that account isn't registered with the vault",
  AssetNotRegistered: "that asset isn't registered with the vault",
  AssetNotAllowed: "this asset isn't in your rule",
  RuleIsPaused: "your rule is paused",
  NotAgent: "only the agent your rule names may open a price check",
  NotPositionOwner: "only the owner may sell this by hand",
  PositionNotOpen: "the position is already sold",
  TakeProfitNotReached: "the price hasn't reached your take-profit level",
  StagnationDelayNotOver: "the stagnation wait isn't over yet",
  PriceOutsideStagnationBand: "the price moved too much for a stagnation exit",
  PriceBeforeBuy: "the price was taken before the investment",
  PriceTooOld: "the signed price is too old, so the market may be closed",
  NotSignedByAirnode: "it wasn't signed by the expected Airnode (a value was edited, or the key is wrong)",
  TweetAlreadyUsed: "this post already started a price check for this asset",
  PriceOutsideTweetWindow: "the price wasn't taken within 10 minutes after the post",
  TriggerNotOpen: "the price check is already closed",
  WaitNotOver: "the minimum wait isn't over yet; the check stays open",
  WindowClosed: "the time window passed; nothing was invested",
  WindowNotClosed: "the time window is still open",
  TrendTooWeak: "the price didn't rise enough",
  SpikeTooHigh: "the price rose more than your maximum rise",
  PerTradeLimitExceeded: "the amount is above your max per investment",
  DailyBudgetExceeded: "this asset's share of today's budget is used up",
  DexDeliveredLess: "the exchange delivered less than it promised",
  // The wallet (live mode)
  NoWallet: "no wallet found: install MetaMask, or use practice mode",
  WrongNetwork: "your wallet is on another network",
  UserRejected: "you cancelled in your wallet",
  NotConnected: "connect your wallet first",
};
const reasonText = e => e.reason ? (REASONS[e.reason] || e.reason) : e.message;

// Everything that ended in a result (Activity shows the latest 5, History shows all)
const results = []; // { time, ok, text }
function addResult(ok, text) {
  results.unshift({ time: Date.now(), ok, text });
  renderResults();
}

// =========================================================
// Login and registration (practice: accounts live in this browser only)
// =========================================================
let session = null;   // logged-in username
let users = {};       // username -> { hash, profile }
const COUNTRIES = ["Germany", "Austria", "Switzerland", "France", "Italy", "Spain", "Netherlands", "Belgium", "Poland", "Sweden",
  "Denmark", "Norway", "Finland", "Ireland", "Portugal", "Czechia", "United Kingdom", "United States", "Canada", "Turkey", "Other"];
const DEFAULT_SETTINGS = { presenter: false, confirmTx: true };

function readStore(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} } // blocked storage: keep in memory
users = readStore("signalVault.users", {});

async function hashPassword(username, password) {
  const data = new TextEncoder().encode(username.toLowerCase() + ":" + password);
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0; for (const b of data) h = (h * 31 + b) >>> 0; // fallback where crypto.subtle is missing
  return "weak-" + h.toString(16);
}

function ageOf(dob) {
  const b = new Date(dob), n = new Date();
  return n.getFullYear() - b.getFullYear() - (n < new Date(n.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
}

function openLogin() {
  $("loginModal").classList.remove("hidden");
  document.body.classList.add("locked");
  setTimeout(() => (!$("loginForm").classList.contains("hidden") ? $("lUser") : $("rFirstName")).focus(), 0);
}
function startSession(username) {
  session = username;
  try { sessionStorage.setItem("signalVault.session", username); } catch {}
  $("loginModal").classList.add("hidden");
  document.body.classList.remove("locked");
  applyProfile();
}

document.querySelectorAll("[data-auth]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-auth]").forEach(x => x.classList.toggle("active", x === b));
  $("loginForm").classList.toggle("hidden", b.dataset.auth !== "login");
  $("registerForm").classList.toggle("hidden", b.dataset.auth !== "register");
});

$("loginForm").onsubmit = async e => {
  e.preventDefault();
  const name = $("lUser").value.trim().toLowerCase(), user = users[name];
  if (!user || user.hash !== await hashPassword(name, $("lPass").value)) { $("loginError").textContent = "Wrong username or password."; return; }
  $("loginError").textContent = "";
  startSession(name);
};

$("registerForm").onsubmit = async e => {
  e.preventDefault();
  const name = $("rUser").value.trim().toLowerCase(), dob = $("rDob").value;
  const fail = msg => { $("registerError").textContent = msg; };
  if (!/^[a-z0-9_.-]{3,30}$/.test(name)) return fail("Username: 3–30 letters, numbers, dots, dashes or underscores.");
  if (users[name]) return fail("That username is taken.");
  if (!dob || new Date(dob) > new Date()) return fail("Enter your real date of birth.");
  if (ageOf(dob) < 18) return fail("You must be 18 or older to create an account.");
  if (!$("rCountry").value) return fail("Choose your country.");
  users[name] = {
    hash: await hashPassword(name, $("rPass").value),
    profile: { firstName: $("rFirstName").value.trim(), lastName: $("rLastName").value.trim(), dob,
               country: $("rCountry").value, city: $("rCity").value.trim(), ...DEFAULT_SETTINGS },
  };
  writeStore("signalVault.users", users);
  fail("");
  startSession(name);
};

$("browseBtn").onclick = () => { $("loginModal").classList.add("hidden"); document.body.classList.remove("locked"); };

// Logged out: every click on a control opens the login instead
document.addEventListener("click", e => {
  if (session || e.target.closest("#loginModal") || !e.target.closest("button, a, input, select, label, textarea")) return;
  e.preventDefault();
  e.stopPropagation();
  openLogin();
}, true);

// =========================================================
// Tabs
// =========================================================
function showTab(name) {
  document.querySelectorAll(".tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("hidden", p.id !== "tab-" + name));
  if (name === "history") renderHistory();
  if (name === "profile") renderProfile();
  if (name === "money") renderMoney();
  if (name === "activity") renderNextStep();
  if (name === "tamper") window.scrollTo({ top: $("tab-tamper").offsetTop - 20, behavior: "smooth" });
}
document.querySelectorAll(".tabs .tab").forEach(t => t.onclick = () => showTab(t.dataset.tab));
document.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => showTab(b.dataset.goto));

// =========================================================
// Ticker tape and summary cards
// =========================================================
// Practice prices start at a random level and drift a little every few seconds.
// Built once and only updated in place, so the scrolling tape never jumps.
for (const a of Object.keys(ASSETS)) Mock.prices[a] = +(ASSETS[a].mockPrice * (1 + (Math.random() - 0.5) * 0.06)).toPrecision(6);
const openPrices = { ...Mock.prices }; // "today's" change is measured from here
$("ticker").innerHTML = Array.from({ length: 4 }, () => Object.keys(ASSETS).map(a =>
  `<span><b>${token(a)}</b><span data-price="${a}"></span> <span data-change="${a}"></span></span>`).join("")).join(""); // repeated so the tape loops
function renderTicker() {
  for (const a of Object.keys(ASSETS)) {
    const ch = (Mock.prices[a] / openPrices[a] - 1) * 100;
    const cls = ch > 0.005 ? "up" : ch < -0.005 ? "down" : "flat";
    document.querySelectorAll(`[data-price="${a}"]`).forEach(el => { el.textContent = fmtPrice(Mock.prices[a]); });
    document.querySelectorAll(`[data-change="${a}"]`).forEach(el => {
      el.className = cls;
      el.textContent = `${ch > 0.005 ? "▲" : ch < -0.005 ? "▼" : "■"} ${fmt(Math.abs(ch))}%`;
    });
  }
}
setInterval(() => {
  for (const a of Object.keys(ASSETS)) Mock.prices[a] = +(Mock.prices[a] * (1 + (Math.random() - 0.5) * 0.005)).toPrecision(6);
  renderTicker();
}, 3000);

function renderStats() {
  $("statVault").textContent = fmt(Mock.vault);
  const cap = Mock.rule ? Mock.dailyCap() : 0;
  $("statSpent").textContent = `${fmt(Mock.spentToday, 0)} / ${fmt(cap, 0)}`;
  $("spentBar").style.width = cap ? Math.min(100, Mock.spentToday / cap * 100) + "%" : "0%";
  const open = Mock.positions.filter(p => p.open);
  $("statPositions").textContent = open.length;
  $("statPositionAssets").textContent = open.length ? [...new Set(open.map(p => token(p.asset)))].join(" · ") : "nothing invested yet";

  // Traffic light: one plain sentence about what is happening right now
  const waiting = Mock.triggers.filter(t => t.status === "pending").length;
  let dot = "ok", text = "all calm · nothing waiting";
  if (!Mock.rule) { dot = "warn"; text = "no rule yet · nothing can be invested"; }
  else if (!Mock.vault && !open.length) { dot = "warn"; text = "rule saved · deposit money in the Money tab"; }
  else if (Mock.paused) { dot = "bad"; text = "rule paused · nothing new will be invested"; }
  else if (waiting) { dot = "warn"; text = `${waiting} price check${waiting > 1 ? "s" : ""} waiting`; }
  $("statusDot").className = "dot " + dot;
  $("statusText").textContent = text;

  $("pauseBtn").disabled = !Mock.rule;
  $("pauseBtn").textContent = Mock.paused ? "Resume rule" : "Pause rule";
  renderTicker();
  renderSentence();
  renderMoney();
}

// =========================================================
// Rule builder
// =========================================================
// Each slider: a plain name, the technical term, and an explanation with a live example.
// Ranges only allow stricter values than the asset profile ("stricter, never looser").
const px = a => Mock.prices[a];
const vaultFor = () => Mock.vault;
const ASSET_SLIDERS = [
  { key: "trend", name: "Minimum price rise", term: "trend threshold", show: v => `+${v}%`,
    range: a => [ASSETS[a].trend, ASSETS[a].trend * 4, 0.5],
    explain: (a, v) => `After the post, the price must rise <b>at least ${v}%</b> before anything is invested. ${token(a)} is at ${fmtPrice(px(a))}, so it would need to reach <b>${fmtPrice(px(a) * (1 + v / 100))}</b>. Default ${ASSETS[a].trend}%; you can only raise it.` },
  { key: "spike", name: "Maximum price rise", term: "spike cap", show: v => `${v}%`,
    range: a => [1, ASSETS[a].spike, 0.5],
    explain: (a, v) => `A jump of <b>more than ${v}%</b> looks like a pump or bad data, so nothing is invested. For ${token(a)}: above <b>${fmtPrice(px(a) * (1 + v / 100))}</b>, no investment. Default ${ASSETS[a].spike}%; you can only lower it.` },
  { key: "minWait", name: "Check the price after", term: "minimum wait", show: fmtMin,
    range: a => [ASSETS[a].minWait, ASSETS[a].minWait * 6, 5],
    explain: (a, v) => `The price is checked again <b>${fmtMin(v)}</b> after the post, so the market has time to react. Default ${fmtMin(ASSETS[a].minWait)}; you can only make it longer.` },
  { key: "maxWindow", name: "Give up after", term: "maximum window", show: fmtMin,
    range: a => [Math.max(60, ASSETS[a].minWait * 2), ASSETS[a].maxWindow, 10],
    explain: (a, v) => `If the rise hasn't happened within <b>${fmtMin(v)}</b> of the post, the signal expires and nothing is invested. Default ${fmtMin(ASSETS[a].maxWindow)}; you can only make it shorter.` },
  { key: "takeProfit", name: "Sell at a gain of", term: "take profit", show: v => `+${v}%`, range: () => [1, 30, 0.5],
    explain: (a, v) => `When an investment is up <b>${v}%</b>, it's sold automatically to lock in the gain. Bought at ${fmtPrice(px(a))} → sold at <b>${fmtPrice(px(a) * (1 + v / 100))}</b>.` },
  { key: "stagnationHours", name: "Sell if nothing happens after", term: "stagnation exit", show: v => `${v} h`, range: () => [1, 72, 1],
    explain: (a, v) => `If after <b>${v} hours</b> the price has barely moved, the investment is sold so your money isn't stuck.` },
  { key: "stagnationBand", name: "\"Barely moved\" means within", term: "stagnation band", show: v => `±${v}%`, range: () => [0.5, 5, 0.5],
    explain: (a, v) => `Within <b>±${v}%</b> of the buying price. Bought at ${fmtPrice(px(a))}: anywhere between ${fmtPrice(px(a) * (1 - v / 100))} and ${fmtPrice(px(a) * (1 + v / 100))}.` },
];
// The budget split sits in the priority list, one slider per asset, all visible together
const SHARE_SLIDER = { key: "share", name: "Share of the daily budget", term: "budget share", show: v => `${v}%`, range: () => [0, 100, 5],
  explain: (a, v) => { const cap = vaultFor() * draft.limits.dailyPct.value / 100; return `${token(a)} may use <b>${v}%</b> of your daily limit${cap ? `: up to <b>${fmt(cap * v / 100, 0)} mUSDC</b> a day` : ""}.`; } };
const LIMIT_SLIDERS = [
  { key: "buyAmount", name: "Amount per investment", term: "trade size", show: v => `${v} mUSDC`, range: () => [10, 1000, 10],
    explain: (_, v) => `How much is invested <b>each time</b> both checks pass: <b>${v} mUSDC</b>.` },
  { key: "maxPerTradePct", name: "Max per investment", term: "max per trade", show: v => `${v}% of vault`, range: () => [1, 5, 0.5],
    explain: (_, v) => `No single investment can be bigger than <b>${v}%</b> of your vault${vaultFor() ? ` (<b>${fmt(vaultFor() * v / 100)} mUSDC</b> right now)` : ""}. Default 5%; you can only lower it.` },
  { key: "dailyPct", name: "Max per day", term: "daily limit", show: v => `${v}% of vault`, range: () => [1, 20, 1],
    explain: (_, v) => `All investments together can't exceed <b>${v}%</b> of your vault per day${vaultFor() ? ` (<b>${fmt(vaultFor() * v / 100)} mUSDC</b> right now)` : ""}. Default 20%; you can only lower it.` },
  { key: "cooldownHours", name: "Pause between investments", term: "cooldown", show: v => `${v} h`,
    range: () => [24, 72, 1],
    explain: (_, v) => `After an investment, the vault waits <b>${v} hours</b> before the next one. Default 24 h; you can only make it longer.` },
];
const SLIDER_BY_KEY = Object.fromEntries([...ASSET_SLIDERS, SHARE_SLIDER, ...LIMIT_SLIDERS].map(s => [s.key, s]));

// The rule being edited. Every value remembers whether the user confirmed it.
const draft = { assets: [], accounts: [], current: null, perAsset: {}, limits: {} };

function defaultFor(asset, key) {
  if (key === "share") {
    const base = Math.floor(100 / draft.assets.length / 5) * 5;
    return base + (asset === draft.assets[0] ? 100 - base * draft.assets.length : 0);
  }
  if (key in SELL_DEFAULTS) return SELL_DEFAULTS[key];
  return ASSETS[asset][key];
}
function limitDefault(key) {
  if (key === "buyAmount") return 50;
  return LIMIT_DEFAULTS[key];
}
for (const s of LIMIT_SLIDERS) draft.limits[s.key] = { value: limitDefault(s.key), confirmed: false };

function sliderHtml(scope, s, entry, asset) {
  const [min, max, step] = s.range(asset);
  const v = Math.min(max, Math.max(min, entry.value));
  entry.value = v;
  const p = max > min ? (v - min) / (max - min) * 100 : 100;
  return `<div class="slider ${entry.confirmed ? "" : "unconfirmed"}" data-scope="${scope}" data-key="${s.key}">
    <div class="slider-top"><div><div class="label">${s.name}</div><div class="term">${s.term}</div></div>
      <span class="value">${s.show(v)}</span>
      <button class="tick" title="confirm this value" aria-label="confirm ${s.name}">✓</button></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" style="--p:${p}%" aria-label="${s.name}">
    <div class="slider-explain">${s.explain(asset, v)}</div></div>`;
}

const unconfirmedCount = a => [...ASSET_SLIDERS.map(s => draft.perAsset[a][s.key]), draft.perAsset[a].share].filter(e => !e.confirmed).length;
const assetConfirmed = a => unconfirmedCount(a) === 0;

// Priority = the order of draft.assets: when a post fits several assets, the first one is served first
function renderPriority() {
  if (!draft.assets.length) { $("priorityList").innerHTML = '<p class="muted small">Pick assets above to set their order and budget.</p>'; return; }
  $("priorityList").innerHTML = draft.assets.map((a, i) => `<div class="prio-row">
      <div class="prio-head"><span class="rank">${i + 1}</span><span class="mono" style="font-weight:600">${token(a)}</span>
        <span class="muted small">${ASSETS[a].label}</span>
        <span class="prio-move"><button class="btn small" data-move="${a}" data-dir="-1" ${i ? "" : "disabled"} aria-label="move ${token(a)} up">↑</button>
        <button class="btn small" data-move="${a}" data-dir="1" ${i < draft.assets.length - 1 ? "" : "disabled"} aria-label="move ${token(a)} down">↓</button></span></div>
      ${sliderHtml(a, SHARE_SLIDER, draft.perAsset[a].share, a)}</div>`).join("") + '<div class="prio-total" id="shareTotal"></div>';
}
$("priorityList").oninput = onSliderInput;
$("priorityList").onclick = e => {
  const mv = e.target.closest("[data-move]");
  if (!mv) return onTick(e);
  const i = draft.assets.indexOf(mv.dataset.move), j = i + Number(mv.dataset.dir);
  [draft.assets[i], draft.assets[j]] = [draft.assets[j], draft.assets[i]];
  renderPriority();
  renderConditions();
  validateRule();
};

function renderRuleBuilder() {
  $("accountPicker").innerHTML = ACCOUNTS.map(acc => {
    const overlap = acc.assets.filter(a => draft.assets.includes(a));
    const never = draft.assets.length && !overlap.length ? "<div class=\"never\">none of this person's assets are in your rule, so their posts can't start anything</div>" : "";
    return `<label><div><div class="name">${acc.name}</div>
      <div class="meta">@${acc.handle} · ${acc.role} · moves ${acc.assets.map(token).join(", ")}</div>${never}</div>
      <input type="checkbox" value="${acc.handle}" ${draft.accounts.includes(acc.handle) ? "checked" : ""} aria-label="watch ${acc.name}"></label>`;
  }).join("");
  $("assetPicker").innerHTML = Object.keys(ASSETS).map(k =>
    `<label title="${ASSETS[k].label}"><input type="checkbox" value="${k}" ${draft.assets.includes(k) ? "checked" : ""}>${token(k)}</label>`).join("");
  renderPriority();
  renderConditions();
  renderLimits();
  validateRule();
}
function renderLimits() {
  $("limits").innerHTML = LIMIT_SLIDERS.map(s => sliderHtml("limits", s, draft.limits[s.key])).join("");
}

function renderConditions() {
  const a = draft.current;
  if (!a) { $("conditions").innerHTML = '<p class="muted">Pick at least one asset in step 2 to set when the vault may invest in it.</p>'; return; }
  const switcher = draft.assets.length > 1 ? `<div class="asset-switch">${draft.assets.map(x =>
    `<button class="btn small ${x === a ? "primary" : ""} ${assetConfirmed(x) ? "" : "todo"}" data-asset="${x}">${token(x)} ${assetConfirmed(x) ? "✓" : "!"}</button>`).join("")}</div>` : "";
  $("conditions").innerHTML = `${switcher}
    <p class="muted small" style="margin-top:0">Settings for <b style="color:var(--text)">${ASSETS[a].label}</b> (${token(a)}) · trading hours ${ASSETS[a].hours}</p>
    <div class="sliders">${ASSET_SLIDERS.map(s => sliderHtml(a, s, draft.perAsset[a][s.key], a)).join("")}</div>`;
}

$("assetPicker").onchange = () => {
  const checked = [...$("assetPicker").querySelectorAll("input:checked")].map(i => i.value);
  draft.assets = [...draft.assets.filter(a => checked.includes(a)), ...checked.filter(a => !draft.assets.includes(a))];
  for (const a of draft.assets) {
    if (!draft.perAsset[a]) {
      draft.perAsset[a] = {};
      for (const s of ASSET_SLIDERS) if (s.key !== "share") draft.perAsset[a][s.key] = { value: defaultFor(a, s.key), confirmed: false };
    }
  }
  for (const a of draft.assets) draft.perAsset[a].share = { value: defaultFor(a, "share"), confirmed: false }; // reset the split
  if (!draft.assets.includes(draft.current)) draft.current = draft.assets[0] || null;
  renderRuleBuilder();
};
$("accountPicker").onchange = () => {
  draft.accounts = [...$("accountPicker").querySelectorAll("input:checked")].map(i => i.value);
  validateRule();
};

function entryFor(box) {
  const { scope, key } = box.dataset;
  return scope === "limits" ? draft.limits[key] : draft.perAsset[scope][key];
}

// Moving a slider or typing counts as confirming; the tick confirms the value as it is
function onSliderInput(e) {
  const box = e.target.closest(".slider");
  if (!box) return;
  const entry = entryFor(box);
  if (e.target.type === "range") {
    const s = SLIDER_BY_KEY[box.dataset.key], scope = box.dataset.scope;
    entry.value = Number(e.target.value);
    box.querySelector(".value").textContent = s.show(entry.value);
    box.querySelector(".slider-explain").innerHTML = s.explain(scope === "limits" ? null : scope, entry.value);
    const min = +e.target.min, max = +e.target.max;
    e.target.style.setProperty("--p", (max > min ? (entry.value - min) / (max - min) * 100 : 100) + "%");
  }
  entry.confirmed = true;
  box.classList.remove("unconfirmed");
  validateRule();
}
function onTick(e) {
  const sw = e.target.closest(".asset-switch button");
  if (sw) { draft.current = sw.dataset.asset; renderConditions(); return; }
  if (!e.target.classList.contains("tick")) return;
  const box = e.target.closest(".slider"), entry = entryFor(box);
  entry.confirmed = !entry.confirmed;
  box.classList.toggle("unconfirmed", !entry.confirmed);
  validateRule();
}
for (const id of ["conditions", "limits"]) { $(id).oninput = onSliderInput; $(id).onclick = onTick; }
$("assetTodo").onclick = e => {
  const b = e.target.closest("[data-fill]");
  if (!b) return;
  draft.current = b.dataset.fill;
  renderConditions();
  validateRule();
  $("conditions").scrollIntoView({ behavior: "smooth", block: "start" });
};

function validateRule() {
  const errors = [];
  let total = 0, confirmed = 0, shareSum = 0;
  const count = e => { total++; if (e.confirmed) confirmed++; };
  for (const a of draft.assets) {
    ASSET_SLIDERS.forEach(s => count(draft.perAsset[a][s.key]));
    count(draft.perAsset[a].share);
    const p = draft.perAsset[a];
    shareSum += p.share.value;
    if (p.minWait.value >= p.maxWindow.value) errors.push(`${token(a)}: "check the price after" must be shorter than "give up after"`);
    if (p.trend.value >= p.spike.value) errors.push(`${token(a)}: the minimum rise must be below the maximum rise`);
  }
  LIMIT_SLIDERS.forEach(s => count(draft.limits[s.key]));
  if (!draft.accounts.length) errors.push("pick at least one person to watch");
  if (!draft.assets.length) errors.push("pick at least one asset");
  if (draft.assets.length && shareSum !== 100) errors.push(`budget shares add up to ${shareSum}%, they need to make 100%`);
  const maxTrade = Mock.vault * draft.limits.maxPerTradePct.value / 100;
  if (Mock.vault && draft.limits.buyAmount.value > maxTrade) errors.push(`the amount per investment is above your max per investment (${fmt(maxTrade)} mUSDC)`);

  // Name every asset that still has unconfirmed values, so none gets forgotten
  const todo = draft.assets.filter(a => !assetConfirmed(a));
  if (todo.length) errors.push(`confirm the values for ${todo.map(token).join(", ")}`);
  $("assetTodo").classList.toggle("hidden", !todo.length || draft.assets.length < 2);
  $("assetTodo").innerHTML = `Still to confirm: ${todo.map(a => `<b>${token(a)}</b> (${unconfirmedCount(a)} value${unconfirmedCount(a) > 1 ? "s" : ""})`).join(", ")}. Every asset has its own settings.<br>` +
    todo.map(a => `<button class="btn small" data-fill="${a}">Fill in ${token(a)} →</button>`).join("");
  document.querySelectorAll(".asset-switch button").forEach(b => {
    const done = assetConfirmed(b.dataset.asset);
    b.textContent = `${token(b.dataset.asset)} ${done ? "✓" : "!"}`;
    b.classList.toggle("todo", !done);
  });

  if ($("shareTotal")) $("shareTotal").innerHTML = `total <b class="mono ${shareSum === 100 ? "gain" : "loss"}">${shareSum}%</b> of the daily limit ${shareSum === 100 ? "✓" : "· must be 100%"}`;
  $("confirmCount").textContent = `${confirmed} of ${total} values confirmed.`;
  $("ruleErrors").textContent = errors.join(" · ");
  $("saveRuleBtn").disabled = errors.length > 0 || confirmed < total;
  renderSentence();
}

// The whole rule in one sentence (updates live while editing)
function renderSentence() {
  if (!draft.assets.length || !draft.accounts.length) {
    $("ruleSentence").textContent = "Pick who to watch and what to invest in, and your rule appears here in one sentence.";
    return;
  }
  const names = draft.accounts.map(shortName);
  const who = names.length > 1 ? names.slice(0, -1).join(", ") + " or " + names.at(-1) : names[0];
  const ranges = draft.assets.map(a => {
    const p = draft.perAsset[a];
    return `${token(a)} +${p.trend.value}% to +${p.spike.value}% between ${fmtMin(p.minWait.value)} and ${fmtMin(p.maxWindow.value)} after the post`;
  }).join("; ");
  const l = draft.limits;
  const daily = Mock.vault ? `${fmt(Mock.vault * l.dailyPct.value / 100, 0)} mUSDC` : `${l.dailyPct.value}% of the vault`;
  const order = draft.assets.length > 1 ? ` If a post fits several assets, they're served in this order: ${draft.assets.map(token).join(" → ")}.` : "";
  $("ruleSentence").innerHTML = `When <em>${esc(who)}</em> posts something the AI links to one of your assets and the signed price then rises (${esc(ranges)}), the vault invests <em>${l.buyAmount.value} mUSDC</em>. At most <em>${daily}</em> a day.${esc(order)} Nothing else can move your money.`;
}

$("saveRuleBtn").onclick = () => {
  if (!ask("Save this rule on-chain?")) return;
  const perAsset = {};
  for (const a of draft.assets) perAsset[a] = Object.fromEntries(ASSET_SLIDERS.map(s => [s.key, draft.perAsset[a][s.key].value]));
  Mock.setRule({ // TODO: contract.setRule(...) once deployed
    assets: [...draft.assets],
    accounts: [...draft.accounts],
    // The AI judges meaning itself; it only gets the standard topic list per asset as a hint
    topics: Object.fromEntries(draft.assets.map(a => [a, TOPICS[a]])),
    perAsset,
    ...Object.fromEntries(LIMIT_SLIDERS.map(s => [s.key, draft.limits[s.key].value])),
  });
  $("saveRuleBtn").textContent = "Saved ✓ · save changes";
  renderStats();
};
$("pauseBtn").onclick = () => { Mock.setPaused(!Mock.paused); renderStats(); };

// =========================================================
// Money: deposit and withdraw, kept apart
// =========================================================
function renderMoney() {
  $("vaultAvail").textContent = fmt(Mock.vault);
  const r = Mock.rule;
  if (!r) return;
  $("budgetBars").innerHTML = r.assets.map(a => {
    const cap = Mock.dailyCap() * r.perAsset[a].share / 100, spent = Mock.spentByAsset[a] || 0;
    return `<div style="margin-bottom:12px"><span class="mono">${token(a)}</span> · ${fmt(spent, 0)} of ${fmt(cap, 0)} mUSDC used today
      <div class="bar" style="margin-top:6px"><div style="width:${cap ? Math.min(100, spent / cap * 100) : 0}%"></div></div></div>`;
  }).join("");
}
function moneyAction(kind) {
  const input = $(kind + "Input"), error = $(kind + "Error"), amount = Number(input.value);
  error.textContent = "";
  if (amount > 0 && !ask(`${kind === "deposit" ? "Deposit" : "Withdraw"} ${fmt(amount)} mUSDC?`)) return;
  try {
    kind === "deposit" ? Mock.deposit(amount) : Mock.withdraw(amount); // TODO: contract calls once deployed
    input.value = "";
    if (kind === "deposit") activityHint = null;
  } catch (err) { error.textContent = reasonText(err); }
  renderStats();
  renderLimits();
  validateRule();
}
$("depositBtn").onclick = () => moneyAction("deposit");
$("withdrawBtn").onclick = () => moneyAction("withdraw");
$("withdrawAllBtn").onclick = () => {
  if (!Mock.vault) { $("withdrawError").textContent = "The vault is already empty."; return; }
  $("withdrawInput").value = Mock.vault;
  moneyAction("withdraw");
};

// =========================================================
// Activity
// =========================================================
const postCards = [];
let activityHint = null; // { text } or { reason, asset } from the last post or price check
let pipelineState = { step: 0, outcome: null }; // how far the newest post got

function renderPipeline() {
  const steps = ["post seen", "relevant?", "check 1 passed", "price checked", "check 2"];
  $("pipeline").innerHTML = steps.map((s, i) => {
    let cls = i < pipelineState.step ? "on" : "";
    if (i === pipelineState.step - 1 && pipelineState.outcome) cls = pipelineState.outcome;
    return `<span class="${cls}">${s}</span>`;
  }).join("<i>→</i>");
}

function addPost(post, label, cls, reason) {
  postCards.unshift(`<div class="item"><div class="meta">${clock(Date.now())} · @${esc(post.handle)}</div>
    <div>“${esc(post.text)}”</div>
    <div class="row"><span class="badge ${cls}">${esc(label)}</span></div>
    ${reason ? `<div class="reason">AI: ${esc(reason)}</div>` : ""}</div>`);
  $("feedPosts").innerHTML = postCards.join("");
}

function renderTriggers() {
  if (!Mock.triggers.length) return;
  const cls = { pending: "warn", executed: "ok", rejected: "bad", expired: "info" };
  const words = { pending: "waiting for the price", executed: "invested", rejected: "blocked", expired: "expired" };
  $("feedTriggers").innerHTML = Mock.triggers.slice().reverse().map(t => {
    const p = t.range;
    const buttons = t.status !== "pending" ? "" : `<div class="row">
      <button class="btn small primary" data-trig="${t.id}" data-elapsed="${p.minWait + 1}">Check price now</button>
      <button class="btn small" data-trig="${t.id}" data-elapsed="${p.minWait / 2}">Too early</button>
      <button class="btn small" data-trig="${t.id}" data-elapsed="${p.maxWindow + 1}">Let it expire</button></div>`;
    return `<div class="item"><div class="meta">@${esc(t.handle)} · ${token(t.asset)}</div>
      <div class="mono">${fmtPrice(t.p0)}${t.p1 ? ` → ${fmtPrice(t.p1)} <span class="${t.p1 >= t.p0 ? "up" : "down"}">(${fmtSigned((t.p1 / t.p0 - 1) * 100)}%)</span>` : ""}</div>
      <div class="reason">needs +${p.trend}% to +${p.spike}% between ${fmtMin(p.minWait)} and ${fmtMin(p.maxWindow)}</div>
      <div class="row"><span class="badge ${cls[t.status]}">${words[t.status]}</span></div>${buttons}</div>`;
  }).join("");
}

function renderResults() {
  const last = results.slice(0, 5);
  $("feedResults").innerHTML = last.length ? last.map(r => `<div class="item"><div class="meta">${clock(r.time)}</div>
    <span class="badge ${r.ok ? "ok" : "bad"}">${r.ok ? "done" : "blocked"}</span> ${esc(r.text)}</div>`).join("")
    : '<p class="muted small">Nothing yet.</p>';
}

$("feedTriggers").onclick = e => {
  const id = +e.target.dataset.trig;
  if (!id) return;
  try {
    const { trigger: t, position: pos } = Mock.confirmTrigger(id, Number(e.target.dataset.elapsed));
    addResult(true, `Invested ${fmt(pos.cost)} mUSDC in ${fmt(pos.qty, 4)} ${token(t.asset)} at the verified price ${fmtPrice(t.p1)}.`);
    pipelineState = { step: 5, outcome: "okay" };
    activityHint = { text: `Both checks passed: the vault invested ${fmt(pos.cost)} mUSDC in ${token(t.asset)}. You'll find it in History.` };
  } catch (err) {
    if (err.reason === "TooEarly") activityHint = { text: "Too early: the price may only be checked after the wait in your rule. The check stays open." };
    else {
      addResult(false, `Blocked: ${reasonText(err)}.`);
      pipelineState = { step: 5, outcome: "fail" };
      activityHint = { reason: err.reason, asset: Mock.triggers.find(x => x.id === id).asset };
    }
  }
  renderTriggers(); renderPipeline(); renderStats(); renderNextStep();
};

// The agent's steps: watched account? relevant? allowed asset? then open a price check.
function handlePost(post) {
  const r = Mock.rule;
  pipelineState = { step: 1, outcome: null };
  const ignore = label => { addPost(post, "ignored: " + label, "info", post.ai.reason); activityHint = { text: `That post was ignored: ${label}. That's normal; most posts don't fit a rule.` }; renderPipeline(); renderNextStep(); };
  if (!r) return ignore("no rule saved yet");
  if (!r.accounts.includes(post.handle)) return ignore(`you don't watch ${accountOf(post.handle).name}`);
  pipelineState.step = 2;
  pipelineState.outcome = "fail";
  if (!post.ai.relevant) return ignore("it isn't about any of your assets");
  if (!r.assets.includes(post.ai.asset) || !accountOf(post.handle).assets.includes(post.ai.asset))
    return ignore(`${token(post.ai.asset)} isn't in your rule for ${shortName(post.handle)}`);
  pipelineState.outcome = null;
  pipelineState.step = 3;
  try {
    const t = Mock.openTrigger(post, post.ai.asset);
    t.range = { ...r.perAsset[t.asset] }; // the rule as it was when this check opened
    addPost(post, `relevant → price check opened (${token(t.asset)})`, "ok", `${post.ai.reason} · confidence ${post.ai.confidence}`);
    pipelineState.step = 4;
    activityHint = null;
    renderTriggers();
  } catch (err) {
    pipelineState.outcome = "fail";
    addPost(post, "relevant, but check 1 refused", "bad", post.ai.reason);
    addResult(false, `Blocked at check 1: ${reasonText(err)}.`);
    activityHint = { reason: err.reason, asset: post.ai.asset };
  }
  renderPipeline(); renderStats(); renderNextStep();
}

const newPostId = () => "18" + Date.now() + Math.floor(Math.random() * 1000);
const playExample = () => handlePost({ ...DEMO_POSTS[Mock.nextPost++ % DEMO_POSTS.length], id: newPostId() });

// One box that always says what happened and what to do next
function renderNextStep() {
  const pending = Mock.triggers.filter(t => t.status === "pending").at(-1);
  const play = (primary = true) => `<button class="btn ${primary ? "primary" : ""}" data-next="play">Play an example post</button>`;
  let text, buttons;
  if (!Mock.rule) {
    text = "<b>First, save your rule</b> in the Your rule tab. Without a rule every post is ignored.";
    buttons = `<button class="btn primary" data-next="rule">Go to Your rule</button>`;
  } else if (!Mock.vault && !Mock.positions.some(p => p.open)) {
    text = "<b>Next, deposit money</b> in the Money tab. The vault can only invest what you put in.";
    buttons = `<button class="btn primary" data-next="money">Go to Money</button>`;
  } else if (pending) {
    text = `<b>Check 1 passed</b> for ${token(pending.asset)} after @${esc(pending.handle)}'s post. <b>Next:</b> the contract checks whether the signed price rose by +${pending.range.trend}% to +${pending.range.spike}%.`;
    buttons = `<button class="btn primary" data-next="check" data-trig="${pending.id}" data-elapsed="${pending.range.minWait + 1}">Check the price now</button>${play(false)}`;
  } else if (activityHint?.reason === "MarketClosed") {
    text = `<b>The ${token(activityHint.asset)} market is closed right now</b> (it only trades ${ASSETS[activityHint.asset].hours}), so check 1 was refused. Tick <b>pretend markets are open</b> above and play another post.`;
    buttons = play();
  } else if (activityHint?.reason === "CooldownActive") {
    text = `<b>Blocked by your pause between investments</b> (${Mock.rule.cooldownHours} h). That's your safety limit working: only one investment per pause.`;
    buttons = play();
  } else if (activityHint?.reason) {
    text = `<b>Blocked:</b> ${esc(reasonText({ reason: activityHint.reason }))}. No money moved. Play another post to try again.`;
    buttons = play();
  } else if (activityHint) {
    text = esc(activityHint.text);
    buttons = play();
  } else {
    text = "<b>Start here:</b> play an example post and follow it through both checks.";
    buttons = play();
  }
  $("nextStep").innerHTML = `<div class="step-text">${text}</div><div class="buttons">${buttons}</div>`;
}
$("nextStep").onclick = e => {
  const b = e.target.closest("[data-next]");
  if (!b) return;
  if (b.dataset.next === "play") playExample();
  else if (b.dataset.next === "check") $("feedTriggers").onclick({ target: b });
  else showTab(b.dataset.next);
};
$("forceOpen").onchange = e => { Mock.forceMarketOpen = e.target.checked; activityHint = null; renderNextStep(); };
Mock.forceMarketOpen = $("forceOpen").checked; // on by default in practice mode, so weekend demos don't stall

// =========================================================
// History
// =========================================================
const currentPrice = p => p.open ? Mock.prices[p.asset] : p.exit;
const gainOf = p => (p.open ? p.qty * Mock.prices[p.asset] : p.proceeds) - p.cost;
let openDetail = null;

function ringSvg(gains, losses) {
  const total = gains + losses, r = 40, c = 2 * Math.PI * r, g = total ? gains / total * c : 0;
  return `<svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label="${gains} gains, ${losses} losses">
    <circle cx="52" cy="52" r="${r}" fill="none" stroke="${total ? "var(--bad)" : "var(--border)"}" stroke-width="11"/>
    <circle cx="52" cy="52" r="${r}" fill="none" stroke="var(--ok)" stroke-width="11" stroke-dasharray="${g} ${c}" transform="rotate(-90 52 52)"/>
  </svg>`;
}

function renderGlance() {
  const all = Mock.positions, closed = all.filter(p => !p.open), enough = closed.length >= 3;
  const gains = closed.filter(p => gainOf(p) >= 0).length;
  const invested = all.reduce((t, p) => t + p.cost, 0), result = all.reduce((t, p) => t + gainOf(p), 0);
  const sorted = closed.slice().sort((a, b) => gainOf(b) - gainOf(a)), best = sorted[0], worst = sorted.at(-1);
  const byAsset = {};
  for (const p of all) byAsset[p.asset] = (byAsset[p.asset] || 0) + gainOf(p);
  const maxAbs = Math.max(1, ...Object.values(byAsset).map(Math.abs));
  const bars = Object.entries(byAsset).map(([a, v]) => {
    const w = Math.abs(v) / maxAbs * 50;
    return `<div class="asset-bar"><span>${token(a)}</span><div class="track"><div class="fill" style="${v >= 0 ? `left:50%;width:${w}%;background:var(--ok)` : `right:50%;width:${w}%;background:var(--bad)`}"></div></div>
      <span class="${v >= 0 ? "gain" : "loss"}" style="text-align:right">${fmtSigned(v)}</span></div>`;
  }).join("") || '<span class="muted small">No investments yet.</span>';
  const link = p => p ? `<button class="link small mono" data-open="${p.id}">${token(p.asset)} <span class="${gainOf(p) >= 0 ? "gain" : "loss"}">${fmtSigned(gainOf(p))}</span></button>` : "–";

  $("glance").innerHTML = `
    <div class="card"><div class="eyebrow">gain / loss ratio</div>
      <div class="ring-wrap" style="margin-top:12px">${ringSvg(enough ? gains : 0, enough ? closed.length - gains : 0)}
        <div>${enough ? `<div class="kpi">${gains} of ${closed.length}</div><div class="muted small">ended with a gain</div>`
                      : '<div>Not enough history yet</div><div class="muted small">shown after 3 closed investments</div>'}</div></div></div>
    <div class="card"><div class="eyebrow">total result</div>
      <div class="kpi ${result >= 0 ? "gain" : "loss"}" style="margin-top:8px">${fmtSigned(result)}</div>
      <div class="muted small mono">mUSDC${enough && invested ? ` · ${fmtSigned(result / invested * 100)}%` : ""}</div>
      <div class="eyebrow" style="margin-top:18px">invested so far</div><div class="kpi" style="margin-top:6px">${fmt(invested)}</div><div class="muted small mono">mUSDC</div></div>
    <div class="card"><div class="eyebrow">best and worst</div>
      <div style="margin:8px 0 16px">best ${link(best)} · worst ${link(best === worst ? null : worst)}</div>
      <div class="eyebrow">result by asset</div><div class="asset-bars" style="margin:10px 0 16px">${bars}</div>
      <div class="eyebrow">blocked by the contract <b class="mono" style="color:var(--text);font-size:1rem;margin-left:6px">${results.filter(r => !r.ok).length}</b></div></div>`;
}

function storyOf(p) {
  const t = p.trigger, acc = accountOf(t.handle), rule = t.range, move = (p.entry / t.p0 - 1) * 100;
  let s = `On ${dateTime(t.t0)}, ${acc.name} posted “${esc(t.text)}”. Your rule links ${shortName(t.handle)} to ${assetName(p.asset)}. ` +
    `The signed price was ${fmtPrice(t.p0)}. ${fmtMin(Math.round(t.elapsedMin))} later it was ${fmtPrice(p.entry)} (${fmtSigned(move)}%), inside your +${rule.trend}% to +${rule.spike}% range, ` +
    `so the vault invested ${fmt(p.cost)} mUSDC in ${fmt(p.qty, 4)} ${token(p.asset)}.`;
  if (!p.open) s += ` It was sold at ${fmtPrice(p.exit)} for ${fmt(p.proceeds)} mUSDC: ${gainOf(p) >= 0 ? "a gain" : "a loss"} of ${fmt(Math.abs(gainOf(p)))} mUSDC.`;
  return s;
}

function detailHtml(p) {
  const t = p.trigger;
  return `<tr class="detail"><td colspan="9">
    <p class="story">${storyOf(p)}</p>
    <ul class="steps">
      <li>${clock(t.t0)} · post from @${esc(t.handle)} judged relevant by the AI</li>
      <li>price check opened with the signed price ${fmtPrice(t.p0)}</li>
      <li>signed price ${fmtPrice(p.entry)} checked by the contract: signer, request, freshness, range and limits all passed</li>
      <li>${clock(p.openedAt)} · swapped ${fmt(p.cost)} mUSDC for ${fmt(p.qty, 4)} ${token(p.asset)}</li>
      ${p.open ? "" : `<li>${clock(p.soldAt)} · sold at ${fmtPrice(p.exit)}</li>`}
    </ul>
    <div class="proof">proof · signer ${EXPECTED_AIRNODE} · request nodary/${p.asset}-USD · transaction link appears here once the contract is live</div>
    ${p.open ? `<div class="buttons" style="margin-top:14px"><button class="btn small primary" data-sell="${p.id}">Sell now at a fresh signed price</button></div>` : ""}
  </td></tr>`;
}

function renderInvestments() {
  const fa = $("fAsset").value, fo = $("fOutcome").value, fs = $("fStatus").value;
  const used = [...new Set(Mock.positions.map(p => p.asset))];
  if ($("fAsset").options.length - 1 !== used.length)
    $("fAsset").innerHTML = '<option value="">every asset</option>' + used.map(a => `<option value="${a}" ${a === fa ? "selected" : ""}>${token(a)}</option>`).join("");
  if (!Mock.positions.length) { $("investments").innerHTML = '<p class="muted">Nothing invested yet. Every investment the vault makes appears here.</p>'; return; }
  const rows = Mock.positions.slice().reverse().filter(p =>
    (!fa || p.asset === fa) && (!fo || (fo === "gain") === (gainOf(p) >= 0)) && (!fs || (fs === "open") === p.open));
  if (!rows.length) { $("investments").innerHTML = '<p class="muted">No investment matches these filters.</p>'; return; }
  const body = rows.map(p => {
    const g = gainOf(p), pct = g / p.cost * 100;
    return `<tr class="inv" data-row="${p.id}"><td>${dateTime(p.openedAt)}</td><td class="mono">${token(p.asset)}</td>
      <td>@${esc(p.trigger.handle)} · “${esc(p.trigger.text.slice(0, 40))}${p.trigger.text.length > 40 ? "…" : ""}”</td>
      <td class="num mono">${fmt(p.cost)}</td><td class="num mono">${fmtPrice(p.entry)}</td>
      <td class="num mono">${fmtPrice(currentPrice(p))}${p.open ? " now" : ""}</td>
      <td class="num mono ${g >= 0 ? "gain" : "loss"}">${fmtSigned(g)} (${fmtSigned(pct)}%)</td>
      <td><span class="badge ${p.open ? "info" : g >= 0 ? "ok" : "bad"}">${p.open ? "still open" : g >= 0 ? "gain" : "loss"}</span></td>
      <td>${p.open ? "open" : p.sellReason}</td></tr>` + (openDetail === p.id ? detailHtml(p) : "");
  }).join("");
  const invested = rows.reduce((t, p) => t + p.cost, 0), result = rows.reduce((t, p) => t + gainOf(p), 0);
  $("investments").innerHTML = `<div class="table-wrap"><table>
    <tr><th>date</th><th>asset</th><th>started by</th><th class="num">invested</th><th class="num">bought at</th><th class="num">now / sold at</th><th class="num">gain / loss</th><th>outcome</th><th>status</th></tr>
    ${body}
    <tr class="totals"><td colspan="3">total (${rows.length})</td><td class="num mono">${fmt(invested)}</td><td></td><td></td>
      <td class="num mono ${result >= 0 ? "gain" : "loss"}">${fmtSigned(result)}</td><td></td><td></td></tr>
  </table></div><p class="muted small">Click a row for the whole story and the proof. Amounts in mUSDC.</p>`;
}

function renderBlocked() {
  const blocked = results.filter(r => !r.ok);
  $("blockedList").innerHTML = blocked.length ? blocked.map(r => `<div class="item"><div class="meta">${clock(r.time)}</div>${esc(r.text)}</div>`).join("")
    : '<p class="muted small">Nothing blocked yet.</p>';
}
function renderHistory() { renderGlance(); renderInvestments(); renderBlocked(); }

for (const id of ["fAsset", "fOutcome", "fStatus"]) $(id).onchange = renderInvestments;
$("tab-history").onclick = e => {
  const sell = e.target.closest("[data-sell]"), open = e.target.closest("[data-open]"), row = e.target.closest("tr.inv");
  if (sell) {
    if (!ask("Sell this investment at a fresh signed price?")) return;
    try {
      const p = Mock.sell(+sell.dataset.sell);
      addResult(true, `Sold ${fmt(p.qty, 4)} ${token(p.asset)} at ${fmtPrice(p.exit)} for ${fmt(p.proceeds)} mUSDC.`);
    } catch (err) { addResult(false, `Sell blocked: ${reasonText(err)}.`); }
    renderStats(); renderHistory();
  } else if (open) { openDetail = +open.dataset.open; renderInvestments(); $("investments").scrollIntoView({ behavior: "smooth" }); }
  else if (row) { openDetail = openDetail === +row.dataset.row ? null : +row.dataset.row; renderInvestments(); }
};

// =========================================================
// Tamper test (for judges, reached from the footer)
// =========================================================
const HIGHLIGHT = { edited: "price", stale: "timestamp", wrongRequest: "requestHash", wrongSigner: "signature" };
let firstTamper = true;
function showResponse(r, kind) {
  $("tamperJson").innerHTML = esc(JSON.stringify(r, null, 2)).split("\n").map(l =>
    HIGHLIGHT[kind] && l.includes(`&quot;${HIGHLIGHT[kind]}&quot;`) ? `<span class="edited">${l}</span>` : l).join("\n");
}
function submitResponse(r, label) {
  let html;
  try {
    const price = Mock.verify(r); // TODO: contract call once deployed
    html = `<span class="badge ok">accepted</span> ${esc(label)}: the verified ETH/USD price ${fmtPrice(price)} was used.`;
  } catch (err) {
    html = `<span class="badge bad">blocked</span> ${esc(label)}: ${esc(reasonText(err))}.`;
  }
  if (firstTamper) { $("tamperResults").innerHTML = ""; firstTamper = false; }
  $("tamperResults").insertAdjacentHTML("afterbegin", `<div class="item"><div class="meta">${clock(Date.now())}</div>${html}</div>`);
}
document.querySelectorAll("#tamperButtons .btn").forEach(btn => btn.onclick = () => {
  const r = Mock.tamper(btn.dataset.kind);
  showResponse(r, btn.dataset.kind);
  submitResponse(r, btn.textContent);
});
$("judgeSubmitBtn").onclick = () => {
  let r;
  try { r = JSON.parse($("judgeJson").value); } catch { return alert("That isn't valid JSON."); }
  if (typeof r.signature !== "string") return alert("The response needs a signature field.");
  showResponse(r);
  submitResponse(r, "pasted response");
};

// =========================================================
// Profile
// =========================================================
const profile = () => session ? users[session].profile : { ...DEFAULT_SETTINGS };
const saveUsers = () => writeStore("signalVault.users", users);
const ask = msg => !profile().confirmTx || confirm(msg);
const shownName = () => profile().firstName || session || "";
const initials = () => (((profile().firstName || session || "?")[0] || "") + ((profile().lastName || "")[0] || "")).toUpperCase();

function applyProfile() {
  document.body.classList.toggle("presenter", !!profile().presenter);
  $("avatarSmall").textContent = $("avatarBig").textContent = session ? initials() : "?";
  $("profileChipName").textContent = session ? shownName() : "log in";
  if (!$("tab-profile").classList.contains("hidden")) renderProfile();
}

function renderProfile() {
  if (!session) return;
  const p = profile();
  $("profileTitle").textContent = `Hi ${shownName()}`;
  $("profileAddress").textContent = `@${session}`;
  const rows = [["first name", p.firstName], ["last name", p.lastName], ["username", "@" + session],
    ["date of birth", p.dob ? `${new Date(p.dob).toLocaleDateString()} (${ageOf(p.dob)})` : ""], ["country", p.country], ["city", p.city]];
  $("detailsView").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="muted">not set</span>'}</dd>`).join("");
  $("presenterToggle").checked = p.presenter;
  $("confirmToggle").checked = p.confirmTx;
}

$("fCountry").innerHTML = $("rCountry").innerHTML = '<option value="">choose…</option>' + COUNTRIES.map(c => `<option>${c}</option>`).join("");
$("profileChip").onclick = () => showTab("profile");
$("editDetailsBtn").onclick = () => {
  const p = profile();
  $("fFirstName").value = p.firstName; $("fLastName").value = p.lastName;
  $("fDob").value = p.dob; $("fCountry").value = p.country; $("fCity").value = p.city;
  $("detailsError").textContent = "";
  $("detailsView").classList.add("hidden"); $("detailsForm").classList.remove("hidden"); $("editDetailsBtn").classList.add("hidden");
};
function closeDetailsForm() {
  $("detailsView").classList.remove("hidden"); $("detailsForm").classList.add("hidden"); $("editDetailsBtn").classList.remove("hidden");
}
$("cancelDetailsBtn").onclick = closeDetailsForm;
$("detailsForm").onsubmit = e => {
  e.preventDefault();
  const dob = $("fDob").value;
  if (!dob || new Date(dob) > new Date() || ageOf(dob) > 120) { $("detailsError").textContent = "That date of birth doesn't look right."; return; }
  if (ageOf(dob) < 18) { $("detailsError").textContent = "You must be 18 or older to use the vault."; return; }
  Object.assign(profile(), { firstName: $("fFirstName").value.trim(), lastName: $("fLastName").value.trim(),
    dob, country: $("fCountry").value, city: $("fCity").value.trim() });
  saveUsers(); applyProfile(); closeDetailsForm(); renderProfile();
};
$("presenterToggle").onchange = e => { profile().presenter = e.target.checked; saveUsers(); applyProfile(); };
$("confirmToggle").onchange = e => { profile().confirmTx = e.target.checked; saveUsers(); };
// Dates: the year may only have 4 digits; anything longer or impossible is cleared.
// Checked when leaving the field, because while typing the year passes through 0001, 0019, …
for (const id of ["rDob", "fDob"]) {
  $(id).max = new Date().toISOString().slice(0, 10); // no birthdays in the future
  $(id).addEventListener("blur", e => {
    const year = e.target.value.split("-")[0];
    if (year && (year.length > 4 || Number(year) < 1900 || Number(year) > new Date().getFullYear())) e.target.value = "";
  });
}
$("logoutBtn").onclick = () => {
  try { sessionStorage.removeItem("signalVault.session"); } catch {}
  location.reload();
};
$("deleteBtn").onclick = () => {
  if (!confirm("Delete your account and details from this browser? On-chain history stays.")) return;
  delete users[session];
  saveUsers();
  $("logoutBtn").onclick();
};

// =========================================================
// Live mode: the deployed vault instead of Mock
// =========================================================
const live = { ready: false, state: null };

function showBanner(html) {
  $("liveBanner").innerHTML = html;
  $("liveBanner").classList.toggle("hidden", !html);
}
const practiceLink = () => {
  const url = new URL(location.href);
  url.searchParams.set("mode", "practice");
  return `<a class="btn small" href="${esc(url.toString())}">Switch to practice mode</a>`;
};

function renderModeChip() {
  const network = NETWORKS[Chain.chainId];
  if (MODE === "practice") {
    $("modeText").textContent = "practice mode";
    $("modeDot").className = "dot warn";
    $("modeChip").title = "Practice money and a practice contract in this browser";
    return;
  }
  $("modeText").textContent = `live · ${network ? network.name : "chain " + Chain.chainId}`;
  $("modeDot").className = "dot " + (live.ready ? "ok" : "bad");
  $("modeChip").title = live.ready ? `Reading the vault at ${Chain.deployment.vault}` : "Not connected to the vault";
}

async function startLive() {
  renderModeChip();
  try {
    await Chain.load();
  } catch (err) {
    showBanner(`<b>Live mode can't start.</b> ${esc(err.message)} ${practiceLink()}`);
    return;
  }
  live.ready = true;
  renderModeChip();
}

// =========================================================
// Start: stay logged in for this tab, otherwise show the login straight away
// =========================================================
if (MODE === "live") startLive(); else renderModeChip();
renderRuleBuilder();
renderPipeline();
renderStats();
renderNextStep();
let remembered = null;
try { remembered = sessionStorage.getItem("signalVault.session"); } catch {}
if (remembered && users[remembered]) startSession(remembered);
else openLogin();
