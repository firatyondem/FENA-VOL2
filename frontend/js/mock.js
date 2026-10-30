// ===== Mock backend =====
// Pretends to be the vault contract + the AI agent so the UI works before the
// contracts exist. Every check here mirrors a check the real contract must do.
// When the contract is deployed, app.js calls the contract instead of Mock.

const EXPECTED_AIRNODE = "0xA1rN0de000000000000000000000000000000001";
const OUR_OWN_KEY      = "0xBAD0000000000000000000000000000000000BAD";
const MAX_RESPONSE_AGE = 5 * 60; // seconds

// Scripted posts for rehearsing the demo. These are NOT real quotes.
// "move" = how much the mock price changes between P0 and P1, in %.
const DEMO_POSTS = [
  { handle: "realDonaldTrump", text: "We are coming for Venezuela",
    ai: { asset: "OIL", relevant: true, confidence: 0.85, reason: "Venezuela military threat, oil supply" }, move: 2.1 },
  { handle: "elonmusk", text: "Starship launch tomorrow 🚀",
    ai: { asset: null, relevant: false, confidence: 0.92, reason: "Rocket launch, no relation to DOGE or TSLA" } },
  { handle: "realDonaldTrump", text: "America will be the crypto capital of the planet",
    ai: { asset: "ETH", relevant: true, confidence: 0.8, reason: "US crypto policy" }, move: 3.6 },
  { handle: "realDonaldTrump", text: "DRILL, BABY, DRILL!",
    ai: { asset: "OIL", relevant: true, confidence: 0.78, reason: "No keyword 'oil', but it is about domestic drilling, so oil supply. Keyword matching would miss this." }, move: 0.6 },
  { handle: "elonmusk", text: "🐕 to the moon",
    ai: { asset: "DOGE", relevant: true, confidence: 0.9, reason: "Dogecoin meme" }, move: 26 },
  { handle: "JDVance", text: "Clear crypto rules will keep innovation in America",
    ai: { asset: "BTC", relevant: true, confidence: 0.82, reason: "Crypto regulation" }, move: 3.4 },
  { handle: "marcorubio", text: "New sanctions on Iran's oil exports take effect today",
    ai: { asset: "OIL", relevant: true, confidence: 0.88, reason: "Iran sanctions, oil supply" }, move: 1.9 },
  { handle: "elonmusk", text: "The EV mandate is over",
    ai: { asset: "TSLA", relevant: true, confidence: 0.75, reason: "EV policy affects Tesla" }, move: 2.5 },
];

class Revert extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

const Mock = {
  vault: 0,               // mock USDC deposited in the vault
  paused: false,
  rule: null,
  triggers: [],
  positions: [],
  usedPostIds: new Set(),
  usedResponses: new Set(),
  spentToday: 0,
  spentByAsset: {},
  lastTradeAt: 0,
  forceMarketOpen: false, // mock-only switch for testing on weekends
  prices: Object.fromEntries(Object.entries(ASSETS).map(([k, a]) => [k, a.mockPrice])),
  nextPost: 0,
  nextId: 1,

  // ---------- Vault ----------
  // Practice money: a deposit simply adds to the vault, a withdrawal takes it out
  deposit(amount) {
    if (!(amount > 0)) throw new Revert("ZeroAmount");
    this.vault += amount;
  },
  withdraw(amount) { // allowed any time, even when paused
    if (!(amount > 0)) throw new Revert("ZeroAmount");
    if (amount > this.vault) throw new Revert("InsufficientVaultBalance");
    this.vault -= amount;
  },
  setPaused(p) { this.paused = p; },
  setRule(rule) { this.rule = rule; },

  dailyCap() { return (this.vault + this.spentToday) * this.rule.dailyPct / 100; },

  // ---------- Market hours (mock version of the contract's check) ----------
  marketOpen(asset) {
    if (this.forceMarketOpen) return true;
    const now = new Date(), day = now.getUTCDay(), h = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (ASSETS[asset].hours === "24/7") return true;
    if (asset === "TSLA") return day >= 1 && day <= 5 && h >= 13.5 && h < 20; // NYSE in UTC, no holidays
    // Oil futures: roughly Sunday 22:00 to Friday 21:00 UTC
    if (day === 6) return false;
    if (day === 5 && h >= 21) return false;
    if (day === 0 && h < 22) return false;
    return true;
  },

  // ---------- Gate 1: open a trigger ----------
  openTrigger(post, asset) {
    const r = this.rule;
    if (!r) throw new Revert("NoRule");
    if (this.paused) throw new Revert("RulePaused");
    if (!r.accounts.includes(post.handle)) throw new Revert("AccountNotWatched");
    if (!r.assets.includes(asset)) throw new Revert("AssetNotInRule");
    if (!ACCOUNTS.find(a => a.handle === post.handle).assets.includes(asset)) throw new Revert("AssetNotLinkedToAccount");
    if (this.usedPostIds.has(post.id)) throw new Revert("PostAlreadyUsed");
    if (!this.marketOpen(asset)) throw new Revert("MarketClosed");
    this.usedPostIds.add(post.id);
    const t = { id: this.nextId++, postId: post.id, handle: post.handle, text: post.text, asset,
                p0: this.prices[asset], t0: Date.now(), move: post.move ?? 0, status: "pending" };
    this.triggers.push(t);
    return t;
  },

  // ---------- Gate 2: confirm with P1 ----------
  // elapsedMin is simulated so the demo doesn't have to wait an hour.
  confirmTrigger(id, elapsedMin) {
    const t = this.triggers.find(x => x.id === id);
    const r = this.rule, p = r.perAsset[t.asset];
    if (t.status !== "pending") throw new Revert("TriggerNotPending");
    const p1 = +(t.p0 * (1 + t.move / 100)).toPrecision(6);
    t.p1 = p1;
    t.elapsedMin = elapsedMin;
    const fail = reason => { t.status = "rejected"; t.reason = reason; throw new Revert(reason); };

    if (elapsedMin < p.minWait) throw new Revert("TooEarly"); // stays pending
    if (elapsedMin > p.maxWindow) { t.status = "expired"; throw new Revert("TriggerExpired"); }
    if (!this.marketOpen(t.asset)) fail("MarketClosed");
    if (p1 > t.p0 * (1 + p.spike / 100)) fail("SpikeCapExceeded");
    if (p1 < t.p0 * (1 + p.trend / 100)) fail("TrendNotMet");

    // Rule limits
    const amount = r.buyAmount;
    if (this.paused) fail("RulePaused");
    if (Date.now() - this.lastTradeAt < r.cooldownHours * 3600e3) fail("CooldownActive");
    if (amount > this.vault * r.maxPerTradePct / 100) fail("MaxPerTradeExceeded");
    if (this.spentToday + amount > this.dailyCap()) fail("DailyLimitReached");
    const assetCap = this.dailyCap() * p.share / 100;
    if ((this.spentByAsset[t.asset] || 0) + amount > assetCap) fail("AssetBudgetUsedUp");
    if (amount > this.vault) fail("InsufficientVaultBalance");

    // Mock DEX swap at exactly the verified P1
    this.vault -= amount;
    this.spentToday += amount;
    this.spentByAsset[t.asset] = (this.spentByAsset[t.asset] || 0) + amount;
    this.lastTradeAt = Date.now();
    this.prices[t.asset] = p1;
    t.status = "executed";
    const pos = { id: this.nextId++, asset: t.asset, qty: amount / p1, entry: p1, cost: amount, openedAt: Date.now(), open: true,
                  trigger: t }; // kept so the history can tell the whole story
    this.positions.push(pos);
    return { trigger: t, position: pos };
  },

  // Manual sell at a fresh signed price (mock: small random move)
  sell(posId) {
    const pos = this.positions.find(p => p.id === posId);
    if (!pos.open) throw new Revert("PositionAlreadySold");
    const price = +(pos.entry * (1 + (Math.random() * 6 - 2) / 100)).toPrecision(6);
    if (!this.marketOpen(pos.asset)) throw new Revert("MarketClosed");
    pos.open = false; pos.exit = price; pos.proceeds = pos.qty * price; pos.soldAt = Date.now(); pos.sellReason = "Sold";
    this.vault += pos.proceeds;
    this.prices[pos.asset] = price;
    return pos;
  },

  // ---------- Signed responses & tamper tests ----------
  // Fake signature = signer + hash of the payload. NOT real cryptography,
  // just enough to show the same decision logic the contract runs.
  hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return "0x" + h.toString(16).padStart(8, "0"); },
  payloadHash(r) { return this.hash(JSON.stringify([r.requestHash, r.timestamp, r.data])); },
  sign(r, key) { return { ...r, signature: key + ":" + this.payloadHash(r) }; },
  expectedRequest() { return this.hash("nodary/ETH-USD"); },

  makeResponse(feed = "nodary/ETH-USD", ageSec = 10, key = EXPECTED_AIRNODE) {
    const r = { requestHash: this.hash(feed), timestamp: Math.floor(Date.now() / 1000) - ageSec,
                data: { price: this.prices.ETH } };
    return this.sign(r, key);
  },

  // Same order of checks the contract runs
  verify(r) {
    const [signer, sigHash] = r.signature.split(":");
    if (sigHash !== this.payloadHash(r)) throw new Revert("InvalidSignature");
    if (signer !== EXPECTED_AIRNODE) throw new Revert("UnexpectedSigner");
    if (r.requestHash !== this.expectedRequest()) throw new Revert("WrongRequestHash");
    if (Math.floor(Date.now() / 1000) - r.timestamp > MAX_RESPONSE_AGE) throw new Revert("ResponseTooOld");
    if (this.usedResponses.has(r.signature)) throw new Revert("ResponseAlreadyUsed");
    this.usedResponses.add(r.signature);
    return r.data.price;
  },

  lastValid: null,
  tamper(kind) {
    let r;
    if (kind === "valid")        r = this.lastValid = this.makeResponse();
    if (kind === "edited")       { r = this.makeResponse(); r.data = { price: +(r.data.price * 1.1).toFixed(2) }; }
    if (kind === "stale")        r = this.makeResponse("nodary/ETH-USD", 3600);
    if (kind === "wrongRequest") r = this.makeResponse("nodary/BTC-USD");
    if (kind === "wrongSigner")  r = this.makeResponse("nodary/ETH-USD", 10, OUR_OWN_KEY);
    if (kind === "replay")       r = this.lastValid || this.makeResponse();
    return r;
  },
};
