# Tweet-Triggered Trading Vault — Feature Spec (API3 Track) — Person A: Vault Core

Oct 30, 2026 · @Niclas

## Ownership & boundaries

Person A owns the vault core contracts: Vault, Gate 1, Gate 2, Selling and their Foundry tests, including the four tamper tests. This section is the team split and not part of the original spec; every section after it is copied word for word from the original, leaving out only rows outside Person A's scope.

| Path | Owner | The other person |
| --- | --- | --- |
| contracts/src/interfaces/ | Person A (frozen at kickoff) | reads only |
| contracts/src/vault/ | Person A | reads only |
| contracts/src/lib/ | Person A | reads only |
| contracts/test/ | Person A | reads only |
| contracts/src/mocks/ | Person B | reads only |
| contracts/script/ | Person B | reads only |
| agent/ | Person B | reads only |
| shared/fixtures/ | Person B | reads only |
| shared/deployments/ | Person B | reads only |
| shared/asset-profiles.json | Person B | reads only |
| foundry.toml, root files | set at kickoff | nobody edits them after kickoff |

**Kickoff (together, about 45 min, before the split):**

1. Skeleton commit; split the starter: Solidity parts into contracts/src/lib/, TypeScript scripts into agent/.
2. Freeze IVault (rule fields, functions, events, errors) and IMockDEX (buy and sell at a verified price).
3. Agree on the exact bytes the agent passes for a signed response.
4. Decide the open points: one rule or several, Base Sepolia and who holds gas and aUSD, and whether a failed Gate 2 reverts or emits an event.

**Hand-offs:** Person B delivers the mocks first (about 1h), because Person A's tests need them; then the signed fixtures (about 2–3h): a signed tweet, a price for a second asset and an old response; then the Base Sepolia deployment, which writes addresses and ABI to shared/deployments/. Person A delivers the frozen interfaces at kickoff.

**Git rules:** each person works on own branches with small PRs and frequent `git pull --rebase`. Each Claude Code session's CLAUDE.md lists only that person's paths. Only Person A changes an interface, in its own small PR, and tells Person B.

Left out of both backend specs: the Frontend feature rows (separate frontend spec), the regulation pitch note, the UI recommendation note under the rule builder, the roadmap, the expected jury criticism, and the open questions on team split and pitch deck.

## Shared context

Identical in both specs.

### Concept

A rule-based trading vault: the user sets a rule once, an AI agent watches posts from market-moving accounts (Elon Musk, Donald Trump, JD Vance, Marco Rubio), and the contract buys only when two gates pass. **Gate 1:** a relevant post was detected. **Gate 2:** a signed AirnodeHub price trend confirms the move. The agent never predicts and never holds funds. It can only trigger a contract that enforces the user's rule against authenticated data.

Built for the API3 track of the TUM Blockchain & AI Hackathon (30–31 Oct 2026, Munich), on a testnet with a mock DEX.

### Core principle: the AI proposes, the contract decides

- **The AI's job:** notice relevant posts, filter noise, and bring proof to the contract.
- **The contract's job:** check every condition itself, using only signed data and the user's stored rule.
- **Consequence:** if the agent is wrong, buggy or malicious, the worst it can do is submit a trigger that gets rejected. It cannot move funds on its own judgment.
- **Why it qualifies:** without a valid signed AirnodeHub price there is no trade, so the integration is essential, not decorative.

### How it works

end-to-end flow · two gates, one decision

The agent can open a trigger and deliver signed prices, but only the contract decides: if the trend or any signature check fails, the trigger reverts or expires and no funds move.

### Security checks and tamper tests

Every signed response (P0, P1 and the post, if signed) passes the same checks before the contract uses it:

1. **Signer:** the recovered signer equals the expected Airnode address.
2. **Request:** the request hash matches the expected operation and parameters (right asset, right feed).
3. **Freshness:** the timestamp is recent, and P1 falls inside the rule's window after P0.
4. **No replay:** each request hash or response is used once; each trigger settles once.
5. **Rule limits:** cooldown, daily spend limit, max spend per trade and pause state are enforced before the swap.

The demo must show one valid run and these four rejections:

| Tamper test | How we fake it | Expected result |
| --- | --- | --- |
| Edited value | Change the price in a real signed response | Revert: signature invalid |
| Stale response | Submit an old signed response | Revert: too old / outside window |
| Different request | Submit a valid response for another asset | Revert: wrong request hash |
| Wrong signer | Sign a response with our own key | Revert: unexpected signer |

Keys and API secrets stay in `.env` files, never in the repo or prompts.

### Scope

Build the MVP rows of the feature table first, on ETH/USD from the official starter, then swap in a stock feed if AirnodeHub lists one.

- **Fallback asset:** ETH (the starter already provides a signed ETH/USD response).
- **Out of scope:** real stock purchases, a real DEX (Uniswap etc.), mainnet deployment, predicting prices, and letting the AI's opinion move funds.

### Signed data sources

Every input that matters has a signed AirnodeHub listing, so all three parts of a decision (post, meaning, price) can be attested.

| Need | Listing | Use | Scope |
| --- | --- | --- | --- |
| Posts (Gate 1) | TwitterAPI.io | userLastTweets for watched accounts; tweet ID for one-trigger-per-post | MVP |
| Crypto prices (Gate 2) | Nodary (free) or the starter's ETH/USD | P0 / P1 for ETH, BTC | MVP |
| Stock and oil prices (Gate 2) | TickerLayer, Twelve Data or EODHD | P0 / P1 for TSLA and crude oil (WTI/Brent) | MVP if a listing covers it |
| Market hours | Finnhub (market calendars) or the price's own source timestamp | Contract refuses to trade while the market is closed | MVP |
| Trend indicator | Twelve Data (technical indicators) | A signed moving average instead of only two raw prices | Stretch |
| AI classification | OpenRouter (LLM chat completions) | The topic → asset classification itself comes back signed, so the contract can see which model said what about which post | Stretch |
| Extra context | Benzinga news, LunarCrush sentiment, Polymarket odds | Shown in the UI next to a trigger; never used to move money | Stretch |

### Decided 30 Oct

- The user confirms each sector once when creating a rule and can change it later; no confirmation per trade.
- The language model decides whether a post relates to an asset. Because its answer isn't signed yet, the contract only accepts that decision from the user's approved agent wallet (the program that ran the model). Once the model's answer is signed (roadmap #2), anyone could submit it and this restriction can go. Anyone can submit the later signed prices.
- A post that matches several assets: assets are served in the user's priority order until the daily budget runs out.
- Tweets only trigger buys; no short selling.
- Proving that a tweet caused a price move is out of scope; the system only checks the user's rule.
- One contract holds every user's funds, with separate balances and rules per user.

### Asset profiles

Default parameters per asset; values are rough starting guesses, to be tied to each asset's typical hourly move. Oil means crude oil (WTI or Brent), since pump prices aren't traded.

| Asset | Mock token | Trading hours | Trend threshold | Spike cap | Min wait → max window |
| --- | --- | --- | --- | --- | --- |
| ETH / BTC | tETH | 24/7 | +3% | 12% | 30 min → 4h |
| Stock (e.g. TSLA) | tTSLA | Exchange hours only | +2% | 8% | 1h → same trading day |
| Crude oil (WTI/Brent) | tOIL | ~24/5 | +1.5% | 5% | 1h → 6h |

Demo rules use short times (e.g. 2 min → 10 min) so the trade completes on stage.

- [ ] Check whether AirnodeHub has an oil price listing
- [ ] Check whether the signed price response includes a source timestamp or market status

## Features

The program has five parts. MVP = needed to qualify and demo; Stretch = only if time allows.

| Component | Feature | What it does | Scope |
| --- | --- | --- | --- |
| Rule (policy) | Create a rule | User picks accounts to watch, topic keywords, asset, trend threshold (e.g. +2%), minimum wait and maximum window (e.g. 1h and 6h), spike cap (e.g. 10%), buy amount | MVP |
| Rule (policy) | Spending limits | Max spend per trade, daily spend limit (e.g. 20% of the vault per 24h, resets daily), cooldown between trades (e.g. 24h) | MVP |
| Rule (policy) | Pause / withdraw | User can pause the rule or withdraw funds at any time | MVP |
| Vault | Deposit funds | User deposits mock USDC into the contract; the agent never holds money | MVP |
| Contract: Gate 1 | Open trigger | Records which rule fired, the post ID and the verified P0. Timing check: P0's source time must fall within e.g. 10 min after the tweet's signed creation time, otherwise revert (no old tweet + new price) | MVP |
| Contract: Gate 1 | Signed post check | Verifies a signed TwitterAPI.io response (userLastTweets): expected Airnode signer, request hash for a watched account, fresh timestamp; stores the tweet ID so it can't trigger twice. Full on-chain parsing of the tweet text stays stretch | MVP |
| Contract: Gate 2 | Trend check | Verifies P1, then checks P1 ≥ P0 × (1 + threshold) and minimum wait ≤ t1 − t0 ≤ maximum window | MVP |
| Contract: Gate 2 | Expiry | A trigger that misses the window expires with no trade. Spike cap: rejects if P1 > P0 × (1 + cap), so a sudden pump (possible trap or bad data) never buys | MVP |

## Design decisions

| Topic | Decision | Answer to the jury |
| --- | --- | --- |
| Gate 2 and limits | Everything that moves money is enforced in the contract against signed data | Removing AirnodeHub data makes trading impossible |
| Market hours | Contract trades only while the market is open. Preferred: reject if the signed source timestamp is older than ~5 min. Fallback: UTC weekday/hours schedule plus an updatable holiday list | A closed market blocks itself; no stale weekend prices |
| Profile limits | Users can make an asset profile stricter, never looser | Nobody can set a 50% spike cap |

## Rule builder

The user writes their own contract conditions. The app pre-fills each field with a general recommended default (the same for every user, from the asset profile below), and the user must confirm or change every value before the rule goes on-chain.

| Condition | User sets | Recommended default | Checked by |
| --- | --- | --- | --- |
| Investment areas | Which assets the rule may buy (ETH, a stock, oil); the AI can never add others | None: the user must choose | Contract (asset allowlist per rule) |
| Accounts to watch | Which accounts trigger the rule (e.g. Trump, Musk, Vance, Rubio) | None: the user must choose | Agent (Gate 1, navigation only) |
| Topics | What posts must be about (e.g. Venezuela, tariffs) | Suggested topics per asset | Agent (Gate 1) |
| Bottom limit (trend threshold) | Minimum price rise needed to buy | From asset profile (e.g. +1.5% oil) | Contract (Gate 2) |
| Top limit (spike cap) | Maximum rise allowed; above it, no buy | From asset profile (e.g. 5% oil) | Contract (Gate 2) |
| Minimum wait | Shortest time between P0 and P1 | From asset profile (e.g. 1h) | Contract (Gate 2) |
| Maximum window | Longest time before the trigger expires | From asset profile (e.g. 6h) | Contract (Gate 2) |
| Max per trade | Largest single purchase | 5% of the vault | Contract (limits) |
| Daily limit | Most that can be spent per 24h | 20% of the vault | Contract (limits) |
| Cooldown | Minimum time between two trades | 24h | Contract (limits) |
| Market hours | Trade only while the market is open | Always on; can't be turned off | Contract |

## Budget priority and position safety

| Feature | How it works | Scope |
| --- | --- | --- |
| Priority via budget split | User splits the daily limit across assets (e.g. oil 50%, ETH 30%, stock 20%). Each asset can only use its share, so a low-priority asset can't eat the whole day's budget. Simpler than a priority queue, because triggers arrive at different times | MVP |
| Leverage cap | Spot only: the vault buys with deposited funds, never borrowed money. Leverage is fixed at 1x by design | MVP |
| Stop loss | User sets a loss limit (e.g. −5%). Anyone can submit a signed price at or below entry × (1 − stop); the contract verifies it and sells the position | Stretch |
| Take profit | Now MVP: see the Selling section | Stretch |
| Max open positions | Caps how many positions can be held at once (e.g. 3) | Stretch |
| One trigger per post | The same post ID can't trigger the same rule twice | MVP |

Stop loss reuses the same signature, request and freshness checks, so it adds a second signed-data path to the demo. Its weakness: it only fires if someone submits a price in time.

## Selling

Selling uses only signed market prices, no tweets. Tweets only ever trigger buys.

| Sell type | Condition (checked by the contract on a signed price P after the buy) | Scope |
| --- | --- | --- |
| Manual sell | User sells a position at any time at a fresh signed price | MVP |
| Take profit | P ≥ entry × (1 + take-profit), e.g. +8%: sell before it drops back | MVP |
| Stagnation exit | At least Z time after the buy (e.g. 24h), P is still within ±Y% of entry (e.g. ±1%): sell to free the money | MVP |
| Stop loss | P ≤ entry × (1 − stop), e.g. −5% | Stretch, same mechanism |

The sell contract runs the same checks as the buy: expected signer, the asset's request, freshness, market open, and each position sells only once. The user sets take-profit, Y and Z per asset profile and can change them later.

## Open questions

**Answered by the official starter:**

- [x] ~~Signature check: `AirnodeV2Attestation.verify` (EIP-191 over requestHash, timestamp, data); covers the four tamper tests~~
- [x] ~~Reading values on-chain: a response projection cuts the JSON to flat fields; `ProjectedJson` reads price, timestamps, tweet ID and text~~
- [x] ~~Market closed: check the price's own source timestamp (e.g. Nodary's `updatedAt`) besides the signature time~~

**Still open:**

- [ ] Decided: each watched account has a pinned-tweet flag; if set, the request reads item #1 instead of #0. The timing check also rejects an old pinned tweet. Still test one call to confirm the order and field names
- [ ] Decided: the post–price timing check is MVP and lives in the contract
- [ ] MVP size: one rule per vault, or several rules with the budget split?
