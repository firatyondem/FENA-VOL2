// ===== Units: every conversion between the page and the contracts =====
// Pure functions, so the page and the Node tests (frontend/test/) run the same code. Amounts the contracts take are
// BigInt; amounts the page shows are plain numbers. Every conversion to the contract rounds down, never up.

(function (root) {
  const ethers = root.ethers || (typeof require !== "undefined" ? require("../vendor/ethers.umd.min.js") : undefined);

  const X_EPOCH_MS = 1288834974657n;
  const PRICE_DECIMALS = 18;
  let usdcDecimals = 6; // read once from MockUSDC.decimals() at startup; 6 if that fails

  // A decimal number or string to an integer with `decimals` places, cutting off further digits (floor for >= 0).
  // A number goes through its shortest decimal form, so 2.3 stays 2.3 and does not become 2.2999…; the exponent form
  // that JavaScript writes for very small or large numbers is read too.
  function toUnits(value, decimals) {
    const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value).trim();
    const match = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match || (!match[2] && !match[3])) throw new Error(`"${value}" is not a number`);
    const [, sign, whole = "", fraction = "", exponent = "0"] = match;
    const digits = (whole || "0") + fraction;
    const shift = (whole || "0").length + Number(exponent) + decimals; // digits that stay in front of the cut
    let units;
    if (shift <= 0) units = 0n;
    else if (shift >= digits.length) units = BigInt(digits) * 10n ** BigInt(shift - digits.length);
    else units = BigInt(digits.slice(0, shift));
    return sign === "-" ? -units : units;
  }

  // An integer with `decimals` places to a plain number, for display
  function fromUnits(units, decimals) {
    const value = BigInt(units);
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
    const text = `${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`;
    return Number(negative ? "-" + text : text);
  }

  const Units = {
    PRICE_DECIMALS,
    setUsdcDecimals(decimals) {
      const d = Number(decimals);
      usdcDecimals = Number.isInteger(d) && d >= 0 && d <= 36 ? d : 6;
    },
    get usdcDecimals() { return usdcDecimals; },

    usdcToUnits: x => toUnits(x, usdcDecimals),
    unitsToUsdc: n => fromUnits(n, usdcDecimals),
    priceFromWei: n => fromUnits(n, PRICE_DECIMALS),
    priceToWei: x => toUnits(x, PRICE_DECIMALS),
    // Asset token amounts, with each token's own decimals (read once per token)
    tokenFromUnits: (n, decimals) => fromUnits(n, decimals),
    toUnits,
    fromUnits,

    pctToBps: p => Math.round(Number(p) * 100),
    bpsToPct: b => Number(b) / 100,
    minToSec: m => Math.round(Number(m) * 60),
    hoursToSec: h => Math.round(Number(h) * 3600),
    secToMin: s => Number(s) / 60,
    secToHours: s => Number(s) / 3600,

    // The vault's asset id: keccak256 of the asset's key, as Deploy.s.sol registers it
    assetIdOf: symbol => ethers.keccak256(ethers.toUtf8Bytes(symbol)),
    // An X id is a Snowflake: its top bits are milliseconds since the X epoch
    tweetTimeMs: id => Number((BigInt(id) >> 22n) + X_EPOCH_MS),

    // A signed response (as the agent serves it) to the vault's SignedResponse struct: the data goes as the exact UTF-8
    // bytes the Airnode signed, the timestamp as a uint256
    signedResponseToContract: r => ({
      requestHash: r.requestHash,
      timestamp: BigInt(r.timestamp),
      data: ethers.hexlify(ethers.toUtf8Bytes(r.data)),
      signature: r.signature,
    }),
    // The price inside a signed price response, for display only: the vault reads the signed bytes itself
    signedPriceValue: r => {
      const price = Number(JSON.parse(r.data).price);
      if (!Number.isFinite(price) || price <= 0) throw new Error("The signed response holds no price");
      return price;
    },
  };

  // ---------- Rule mapping ----------
  // A plain draft: { assets: [key], accounts: [handle], perAsset: { key: { trend, spike, minWait, maxWindow,
  // takeProfit, stagnationHours, stagnationBand, share } }, limits: { buyAmount, maxPerTradePct, dailyPct,
  // cooldownHours } }, in the page's units (%, minutes, hours, mUSDC).
  // ctx: { deployment: { assetIds }, requestHashes: { posts }, vaultBalance (mUSDC), agent, profiles?: { key: on-chain
  // AssetProfile } }

  // Freezes the percent-of-vault limits into absolute amounts, as the vault stores them
  function absoluteLimits(draft, ctx) {
    const l = draft.limits;
    const balance = Units.usdcToUnits(ctx.vaultBalance || 0);
    return {
      buyAmount: Units.usdcToUnits(l.buyAmount),
      maxPerTrade: (balance * BigInt(Units.pctToBps(l.maxPerTradePct))) / 10000n,
      dailyLimit: (balance * BigInt(Units.pctToBps(l.dailyPct))) / 10000n,
    };
  }

  // IVault.setRule's five arguments, the same as agent/src/chain/setup.ts sends
  Units.ruleToContract = function (draft, ctx) {
    const limits = absoluteLimits(draft, ctx);
    const assetIds = draft.assets.map(a => {
      const id = ctx.deployment.assetIds[a];
      if (!id) throw new Error(`${a} is not deployed on this network`);
      return id;
    });
    const assetRules = draft.assets.map(a => {
      const p = draft.perAsset[a];
      return {
        thresholdBps: Units.pctToBps(p.trend),
        spikeCapBps: Units.pctToBps(p.spike),
        minWait: Units.minToSec(p.minWait),
        maxWindow: Units.minToSec(p.maxWindow),
        cooldown: Units.hoursToSec(draft.limits.cooldownHours),
        budgetShareBps: Units.pctToBps(p.share),
        takeProfitBps: Units.pctToBps(p.takeProfit),
        stagnationBandBps: Units.pctToBps(p.stagnationBand),
        stagnationDelay: Units.hoursToSec(p.stagnationHours),
      };
    });
    const topics = draft.assets.map(a => (draft.topics && draft.topics[a] ? draft.topics[a] : []).join(", "));
    const watched = draft.accounts.map(h => {
      const post = ctx.requestHashes.posts[h];
      if (!post) throw new Error(`@${h} is not a watchable account`);
      return post.requestHash;
    });
    return [{ agent: ctx.agent, ...limits }, assetIds, assetRules, topics, watched];
  };

  // An on-chain rule back into a plain draft. Limits that the vault stores in mUSDC come back as a percent of the
  // current vault balance, so they move when the balance moves.
  Units.contractToRule = function (onchain, ctx) {
    const keyOf = Object.fromEntries(Object.entries(ctx.deployment.assetIds).map(([k, id]) => [id.toLowerCase(), k]));
    const handleOf = Object.fromEntries(Object.entries(ctx.requestHashes.posts).map(([h, p]) => [p.requestHash.toLowerCase(), h]));
    const balance = Units.usdcToUnits(ctx.vaultBalance || 0);
    const pctOf = amount => (balance > 0n ? Number((BigInt(amount) * 10000n) / balance) / 100 : 0);
    const assets = [], perAsset = {}, topics = {};
    onchain.assetIds.forEach((id, i) => {
      const key = keyOf[String(id).toLowerCase()];
      const r = onchain.assetRules[i];
      if (!key || !r) return;
      assets.push(key);
      perAsset[key] = {
        trend: Units.bpsToPct(r.thresholdBps), spike: Units.bpsToPct(r.spikeCapBps),
        minWait: Units.secToMin(r.minWait), maxWindow: Units.secToMin(r.maxWindow),
        takeProfit: Units.bpsToPct(r.takeProfitBps), stagnationHours: Units.secToHours(r.stagnationDelay),
        stagnationBand: Units.bpsToPct(r.stagnationBandBps), share: Units.bpsToPct(r.budgetShareBps),
      };
      topics[key] = String((onchain.topics || [])[i] || "").split(",").map(t => t.trim()).filter(Boolean);
    });
    const first = onchain.assetRules[0];
    return {
      assets,
      accounts: onchain.watchedAccounts.map(h => handleOf[String(h).toLowerCase()]).filter(Boolean),
      perAsset,
      topics,
      limits: {
        buyAmount: Units.unitsToUsdc(onchain.rule.buyAmount),
        maxPerTradePct: pctOf(onchain.rule.maxPerTrade),
        dailyPct: pctOf(onchain.rule.dailyLimit),
        cooldownHours: first ? Units.secToHours(first.cooldown) : 0,
      },
      absolute: {
        maxPerTrade: Units.unitsToUsdc(onchain.rule.maxPerTrade),
        dailyLimit: Units.unitsToUsdc(onchain.rule.dailyLimit),
      },
      agent: onchain.rule.agent,
    };
  };

  // The checks IVault.setRule makes, run before the wallet opens. Returns plain-English problems; none means it can go.
  Units.validateRule = function (draft, ctx) {
    const errors = [];
    const zero = /^0x0{40}$/i;
    if (!ctx.agent || zero.test(ctx.agent)) errors.push("this network has no agent address configured, so no rule can name one");
    if (!(Number(ctx.vaultBalance) > 0)) errors.push("deposit first: the limits are a share of your vault balance");
    if (!draft.assets.length) errors.push("pick at least one asset");
    if (!draft.accounts.length) errors.push("pick at least one person to watch");
    if (new Set(draft.assets).size !== draft.assets.length) errors.push("an asset is in the rule twice");
    if (new Set(draft.accounts).size !== draft.accounts.length) errors.push("an account is watched twice");
    const limits = absoluteLimits(draft, ctx);
    if (limits.buyAmount <= 0n) errors.push("the amount per investment must be above 0");
    else if (Number(ctx.vaultBalance) > 0 && limits.buyAmount > limits.maxPerTrade) {
      errors.push(`the amount per investment is above your max per investment (${Units.unitsToUsdc(limits.maxPerTrade)} mUSDC)`);
    }
    let shares = 0;
    for (const a of draft.assets) {
      const p = draft.perAsset[a];
      shares += Units.pctToBps(p.share);
      if (Units.pctToBps(p.trend) > Units.pctToBps(p.spike)) errors.push(`${a}: the minimum rise is above the maximum rise`);
      if (Units.minToSec(p.minWait) > Units.minToSec(p.maxWindow)) errors.push(`${a}: "check the price after" is after "give up after"`);
      const profile = ctx.profiles && ctx.profiles[a];
      if (profile) {
        const looser = [];
        if (Units.pctToBps(p.trend) < Number(profile.minThresholdBps)) looser.push(`minimum rise below ${Units.bpsToPct(profile.minThresholdBps)}%`);
        if (Units.pctToBps(p.spike) > Number(profile.maxSpikeCapBps)) looser.push(`maximum rise above ${Units.bpsToPct(profile.maxSpikeCapBps)}%`);
        if (Units.minToSec(p.minWait) < Number(profile.minWait)) looser.push(`wait shorter than ${Units.secToMin(profile.minWait)} min`);
        if (Units.minToSec(p.maxWindow) > Number(profile.maxWindow)) looser.push(`window longer than ${Units.secToMin(profile.maxWindow)} min`);
        if (looser.length) errors.push(`${a} is looser than its profile allows: ${looser.join(", ")}`);
      }
      if (ctx.deployment && !ctx.deployment.assetIds[a]) errors.push(`${a} is not deployed on this network`);
    }
    if (shares > 10000) errors.push(`budget shares add up to ${shares / 100}%, at most 100%`);
    for (const h of draft.accounts) if (ctx.requestHashes && !ctx.requestHashes.posts[h]) errors.push(`@${h} is not a watchable account`);
    return errors;
  };

  root.Units = Units;
  if (typeof module !== "undefined") module.exports = Units;
})(typeof window !== "undefined" ? window : globalThis);
