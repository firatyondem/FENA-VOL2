# Spec: Person A (Fırat), contract, data and agent

Read [00-overview.md](00-overview.md) first: it has the interfaces Person B builds against. Change them only after
agreeing with B.

## A1. Pyth prices in the vault (week 1)

**Why:** Airnode responses cost 0.01 aUSD per call and Nodary/TickerLayer cover few assets. Pyth works the same way
(a signed price update that the contract verifies itself), covers US stocks, 100+ ETFs, commodities and crypto, and
is live on Base. Anyone can fetch updates for free from Pyth's Hermes API; the contract pays a small update fee.

**Tasks**
- Replace `AirnodeV2Attestation` price checks in `Vault.sol` with Pyth (`@pythnetwork/pyth-sdk-solidity`).
  `AssetProfile` stores a Pyth `priceId` instead of `airnode` + `priceRequestHash`.
- Use `pyth.parsePriceFeedUpdates(update, ids, minPublishTime, maxPublishTime)` instead of reading the latest price.
  This lets the vault demand a price **from a time window**, which fixes the hackathon's open problem: P0 must be
  published within 10 minutes after the post, and the agent can no longer pick a favourable older price.
  Check the exact function in the current Pyth EVM docs before building on it.
- Keep every protection from the hackathon: wrong asset (`priceId` mismatch), too old, and replay (store the
  `publishTime` already used per trigger/position). Map each failure to a named error, as before.
- Handle Pyth's `expo` and confidence interval: convert to 18 decimals; refuse a price whose confidence is wider than
  a profile setting (`maxConfBps`).
- Equities only trade in market hours. Keep the `maxPriceAge` idea so a closed market's price is refused.
- Add the Pyth contract address for Base Sepolia and the feed IDs (ETH, BTC, DOGE, TSLA, SPY, WTI or another oil
  feed) to `shared/asset-profiles.json`.

**Done when:** `forge test` passes with tests that use real Hermes update payloads saved as fixtures, and the tamper
test (edited, old, wrong-asset, replayed update) is rewritten for Pyth and passes on the deployed vault.

## A2. Stop-loss in the vault (week 1)

Today `stopLossBps` exists only in the agent's keeper (`agent/src/engine/keeper.ts`), but `SellReason` has no
`StopLoss`, so the vault cannot enforce it.

- Add `StopLoss` to `SellReason` and `stopLossBps` to `AssetRule`, with a profile limit (`maxStopLossBps`).
- `sell(..., StopLoss, update)` succeeds for **any caller** when `P <= entry * (1 - stopLossBps)`, like take-profit.
- The keeper sells on stop-loss through the vault.

**Done when:** tests cover stop-loss exactly at, above and below the line, with stop-loss turned off, and on a paused
rule.

## A3. Manual sell without the console (week 1)

With Pyth, the website can fetch a price update from Hermes itself, so manual sell no longer needs the agent's
`/api/signed-price`. Make sure `sell(positionId, Manual, update)` works for the position owner with any fresh update,
and is refused for anyone else. Give B a tiny helper or example in `shared/` showing how to get the update and the
fee from TypeScript.

## A4. Cheaper posts (week 1)

- Put post fetching behind one interface in `agent/src/sources/` (`fetchNewPosts(account, sinceId)`), with
  implementations for **GetXAPI** (about $0.05 per 1,000 tweets) and **TwitterAPI.io** (about $0.15 per 1,000).
  Pick by config. Check both providers' current docs: whether they bill per call or per tweet, and whether they
  support "only posts newer than an ID".
- **Shared polling:** poll each watched account once per cycle and hand the posts to every rule that watches it.
- **Smart polling:** poll often (e.g. every minute) during market hours and right after an account posted, rarely
  (e.g. every 10–15 minutes) at night and after long quiet periods. Make the schedule configurable.
- Posts are no longer signed, so the vault can't prove a post is real. Write that trade-off in the README: a fake post
  can at most open a price check, and the vault still won't buy unless Pyth prices confirm the move.

## A5. Cheaper AI (week 2)

- Run the existing keyword filter (`agent/src/classifier/keyword.ts`) first. Posts with no match at all are
  `skipped-by-filter` and never reach a model.
- Use a small, cheap Claude model for the rest. Only escalate to a bigger model if the small one is unsure.
- Cache every verdict by `tweetId + assetId`, so a post is never classified twice (also across restarts).

## A6. Cost ledger and `/api/costs` (week 1–2)

- Every paid action writes one row to a ledger: time, user(s) it served, kind (`post-fetch`, `ai-call`,
  `price-update-fee`, `gas`), units and cost in USD. When one poll serves several users, split its cost evenly.
- Store it in SQLite (one file, easy to host).
- Serve `GET /api/costs` exactly as in the overview.
- Measure before and after A4/A5 and put both numbers in the README.

## A7. Decision log and `/api/decisions` (week 2)

For every post the agent sees, store: post, verdict and the model's one-line reason, and for each asset the gate
outcome (`opened`, `bought`, `expired` or the vault's error name) with the transaction hash. Serve
`GET /api/decisions` as in the overview. Never log API keys or private keys.

## A8. Strategy changes on the agent side (week 1)

B reports why changing a rule failed in the hackathon version. On the agent side, make sure that:
- the agent picks up a new `RuleSet` within one poll, without a restart
- open triggers from the old rule are expired or finished cleanly, and open positions keep their sell rules
- a test covers "set rule, open trigger, change rule, next post uses the new rule"

## A9. Demo faucet (week 1)

`POST /api/demo/faucet { address }` sends a little Base Sepolia ETH and mUSDC to a demo address. Limit it to once per
address per day and a total per day, so nobody can drain the faucet wallet. Keep the faucet key only in the server's
secrets.

## A10. Host it 24/7 (week 2)

- Deploy the agent and its console to a small always-on host (Fly.io or Railway; compare current free/cheap tiers).
  Use the existing supervisor (`npm run live:supervised`) so it restarts after a crash.
- HTTPS, CORS for the website's origin only, secrets in the host's secret store, the SQLite file on a persistent
  volume.
- `GET /api/health` for an uptime check.

## Order

A1 → A2 → A3 (contract, one deploy) → A9 → A4 → A6 → A8 → A5 → A7 → A10. Deploy the contract once A1–A3 are done and
send B the new address and ABI right away.
