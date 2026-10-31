// Run from the repo root: node --test "frontend/test/*.test.mjs"
// The rule-mapping test imports the agent's own setup.ts, so run `npm install` in agent/ first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const Units = require("../js/units.js");
const shared = path => JSON.parse(readFileSync(new URL(`../../shared/${path}`, import.meta.url), "utf8"));
const agentFile = path => JSON.parse(readFileSync(new URL(`../../agent/${path}`, import.meta.url), "utf8"));

const deployment = shared("deployments/31337.json");
const requestHashes = shared("deployments/request-hashes.json");
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

test("a signed response goes to the vault exactly as the agent sends it", async () => {
  const { toVaultResponse } = await import("../../agent/src/chain/viem-vault.ts");
  for (const file of ["eth-p1-rise.json", "tweet-trump-venezuela.json"]) {
    const response = shared(`fixtures/synthetic/${file}`);
    assert.deepEqual(Units.signedResponseToContract(response), toVaultResponse(response), file);
  }
  assert.equal(Units.signedPriceValue(shared("fixtures/synthetic/eth-p1-rise.json")), 2070);
  assert.equal(Units.signedPriceValue({ data: '{"price":"0.075845","updatedAt":1}' }), 0.075845, "a quoted price");
  assert.throws(() => Units.signedPriceValue({ data: '{"price":null}' }), /no price/);
});

test("USDC amounts round-trip with 6 decimals and round down", () => {
  assert.equal(Units.usdcToUnits(2.3), 2_300_000n, "2.3 stays 2.3, not 2.2999");
  assert.equal(Units.usdcToUnits("0.1234567"), 123_456n, "floor, never up");
  assert.equal(Units.usdcToUnits(10_000), 10_000_000_000n);
  assert.equal(Units.usdcToUnits(1e-7), 0n);
  assert.equal(Units.unitsToUsdc(2_300_000n), 2.3);
  assert.equal(Units.unitsToUsdc(Units.usdcToUnits("544.999999")), 544.999999);
  assert.throws(() => Units.usdcToUnits("abc"), /not a number/);
});

test("the USDC decimals come from the token, with 6 as the fallback", () => {
  Units.setUsdcDecimals(18);
  assert.equal(Units.usdcToUnits(1), 10n ** 18n);
  Units.setUsdcDecimals("nonsense");
  assert.equal(Units.usdcDecimals, 6);
  assert.equal(Units.usdcToUnits(1), 1_000_000n);
});

test("prices have 18 decimals", () => {
  assert.equal(Units.priceFromWei(2_244_695_000_000_000_000_000n), 2244.695);
  assert.equal(Units.priceToWei("2244.695"), 2_244_695_000_000_000_000_000n);
  assert.equal(Units.priceFromWei(75_845_000_000_000_000n), 0.075845);
  assert.equal(Units.tokenFromUnits(241_545_893_719_806_763n, 18), 0.241545893719806763);
});

test("basis points and seconds", () => {
  assert.equal(Units.pctToBps(1.5), 150);
  assert.equal(Units.pctToBps(2.3), 230);
  assert.equal(Units.bpsToPct(150), 1.5);
  assert.equal(Units.minToSec(2), 120);
  assert.equal(Units.hoursToSec(1 / 60), 60);
  assert.equal(Units.hoursToSec(24), 86_400);
  assert.equal(Units.secToMin(600), 10);
  assert.equal(Units.secToHours(86_400), 24);
});

test("asset ids match what Deploy.s.sol registered", () => {
  for (const [key, id] of Object.entries(deployment.assetIds)) assert.equal(Units.assetIdOf(key), id, key);
});

test("a post's time comes from its X id", () => {
  const tweet = shared("fixtures/synthetic/tweet-trump-venezuela.json");
  const manifest = shared("fixtures/synthetic/manifest.json");
  assert.equal(Units.tweetTimeMs(JSON.parse(tweet.data).id), manifest.times.tweetCreatedAt * 1000);
});

// The page's draft for agent/config/rule.example.json, in the page's units, on a vault holding the example deposit
const exampleDraft = config => {
  const cooldowns = new Set(config.assets.map(a => a.cooldownSec));
  assert.equal(cooldowns.size, 1, "the page has one cooldown for all assets");
  return {
    assets: config.assets.map(a => a.asset),
    accounts: config.accounts,
    perAsset: Object.fromEntries(config.assets.map(a => [a.asset, {
      trend: a.trendThresholdBps / 100, spike: a.spikeCapBps / 100, minWait: a.minWaitSec / 60, maxWindow: a.maxWindowSec / 60,
      takeProfit: a.takeProfitBps / 100, stagnationHours: a.stagnationAfterSec / 3600,
      stagnationBand: a.stagnationBandBps / 100, share: a.budgetShareBps / 100,
    }])),
    topics: Object.fromEntries(config.assets.map(a => [a.asset, a.topics])),
    limits: {
      buyAmount: config.buyAmountUsdc,
      maxPerTradePct: (config.maxPerTradeUsdc / config.depositUsdc) * 100,
      dailyPct: (config.dailyLimitUsdc / config.depositUsdc) * 100,
      cooldownHours: [...cooldowns][0] / 3600,
    },
  };
};

test("setRule gets exactly the arguments the agent's set-rule script sends", async () => {
  const { setRuleArgs } = await import("../../agent/src/chain/setup.ts");
  const config = agentFile("config/rule.example.json");
  const watchlist = agentFile("config/watchlist.json");
  const ctx = { deployment, requestHashes, vaultBalance: config.depositUsdc, agent: AGENT };
  assert.deepEqual(Units.ruleToContract(exampleDraft(config), ctx), setRuleArgs(config, AGENT, watchlist));
});

test("an on-chain rule reads back into the same draft", () => {
  const config = agentFile("config/rule.example.json");
  const draft = exampleDraft(config);
  const ctx = { deployment, requestHashes, vaultBalance: config.depositUsdc, agent: AGENT };
  const [rule, assetIds, assetRules, topics, watchedAccounts] = Units.ruleToContract(draft, ctx);
  const back = Units.contractToRule({ rule, assetIds, assetRules, topics, watchedAccounts }, ctx);
  assert.deepEqual(back.assets, draft.assets);
  assert.deepEqual(back.accounts, draft.accounts);
  assert.deepEqual(back.perAsset, draft.perAsset);
  assert.deepEqual(back.topics, draft.topics);
  assert.deepEqual(back.limits, draft.limits);
  assert.deepEqual(back.absolute, { maxPerTrade: 500, dailyLimit: 2000 });
});

test("the checks setRule makes run before the wallet opens", () => {
  const config = agentFile("config/rule.example.json");
  const ctx = {
    deployment, requestHashes, vaultBalance: config.depositUsdc, agent: AGENT,
    profiles: { ETH: { minThresholdBps: 300, maxSpikeCapBps: 1200, minWait: 120, maxWindow: 14400 } },
  };
  const valid = exampleDraft(config);
  assert.deepEqual(Units.validateRule(valid, ctx), []);
  const broken = change => {
    const draft = structuredClone(valid);
    change(draft);
    return Units.validateRule(draft, ctx).join(" | ");
  };
  assert.match(broken(d => { d.perAsset.OIL.share = 60; }), /add up to 110%/);
  assert.match(broken(d => { d.limits.buyAmount = 501; }), /above your max per investment/);
  assert.match(broken(d => { d.perAsset.OIL.trend = 6; }), /OIL: the minimum rise is above the maximum rise/);
  assert.match(broken(d => { d.perAsset.OIL.minWait = 11; }), /OIL: "check the price after" is after "give up after"/);
  assert.match(broken(d => { d.perAsset.ETH.spike = 15; }), /ETH is looser than its profile allows: maximum rise above 12%/);
  assert.match(broken(d => { d.perAsset.ETH.trend = 2; d.perAsset.ETH.minWait = 1; }), /minimum rise below 3%, wait shorter than 2 min/);
  assert.match(broken(d => { d.assets.push("OIL"); }), /an asset is in the rule twice/);
  assert.match(broken(d => { d.accounts.push("elonmusk"); }), /an account is watched twice/);
  assert.match(Units.validateRule(valid, { ...ctx, vaultBalance: 0 }).join(" | "), /deposit first/);
  assert.match(Units.validateRule(valid, { ...ctx, agent: "" }).join(" | "), /no agent address/);
});
