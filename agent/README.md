# Agent

The agent notices posts, filters noise and brings Pyth prices to the vault. It never predicts and never holds funds:
the worst a wrong or malicious agent can do is open a price check that never buys.

```
post (GetXAPI or TwitterAPI.io) ──> keyword filter ──> Claude Haiku (Opus if unsure) ──> openTrigger(user, asset, post, P0)   Gate 1
                                                                                     └─> confirmTrigger(trigger, P1)          Gate 2
Pyth update (Hermes) ──> sell keeper ──────────────────────────────────────────────> sell(take-profit | stop-loss | stagnation)
```

P0 is the first Pyth price published at or after the post, so the agent cannot pick a favourable one; the vault checks
that with Pyth's own uniqueness rule. Every paid action goes into a SQLite cost ledger, every post and what the vault
did with it into a decision log.

## Run it

Needs Node 22.18+ (it runs the `.ts` sources directly) and Foundry.

```sh
cd agent
npm install
npm test           # unit tests, no network
npm run test:e2e   # the agent against the real Vault and LocalPyth on a local anvil (anvil and forge on PATH)
npm start          # The Wire Desk console at http://127.0.0.1:4173, replay mode
```

`npm start` without keys runs the **stage replay**: the real engine, classifier and keeper against an in-memory copy of
the vault's checks, fed with scripted posts and Pyth price paths on a 10x clock. It shows one valid run (an oil buy at
P1, then a take-profit sell) and the four tamper rejections (edited, old, wrong-asset and replayed price). With
`ANTHROPIC_API_KEY` set, Claude classifies the posts instead of the keyword baseline; the Ðogecoin post shows the
difference.

## Deploy and go live

From `contracts/`, with `npm ci` run there once (it installs the Pyth SDK):

```sh
forge script Deploy --rpc-url $RPC_URL --broadcast   # PRIVATE_KEY in the environment
```

Git Bash on Windows rewrites a `script/Deploy.s.sol` argument and forge refuses it, so name the contract instead.

`Deploy.s.sol` deploys mock USDC, the mock DEX, tOIL, tDOGE, tETH, tBTC, tTSLA, tSPY and the `Vault`, registers every
asset profile from `shared/asset-profiles.json` (asset id `keccak256("OIL")`, its Pyth feed, the limits with a 2-minute
demo wait) and every account of `config/watchlist.json` (`keccak256` of the lower-case handle), and writes the addresses
to `shared/deployments/<chain id>.json`. The Pyth contract comes from `PYTH`, else from the profiles file (Base Sepolia:
`0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`); a plain local chain gets `LocalPyth`, which checks no signatures.
`DEMO_WAITS=false` keeps the spec's 30 min to 1 h waits.

Then, in `agent/` with `.env` filled in (see `.env.example`):

```sh
npm run export-abi   # after any vault change: ABIs to shared/deployments/abi/, types to src/chain/vault-abi.ts
npm run set-rule     # the demo user deposits mock USDC and sets config/rule.example.json with this agent
AGENT_MODE=live npm start   # or npm run live:supervised, which restarts it after a crash
```

Live mode needs a Pyth API key: Hermes has required one since 26 August 2026. The website never sees it; it asks the
agent's `/api/price-update` instead.

In live mode the agent reads its users from the vault: everyone whose latest `RuleSet` names its wallet, with their
assets, limits, watched accounts and topics. It finds open positions and the exits they were bought with from the
chain, so a restart loses none.

## HTTP API

Served by the console server; pages on `CONSOLE_ALLOWED_ORIGINS` may call it.

| Route | Returns |
| --- | --- |
| `GET /api/health` | `{ ok, lastPollAt, version, mode }`, 503 when cycles stopped |
| `GET /api/costs?user=0x..&days=7` | per UTC day: `{ date, posts, aiCalls, priceUpdates, gasWei, totalUsd, bySource }` |
| `GET /api/decisions?user=0x..&limit=50` | per post: `{ tweetId, account, text, createdAt, verdict, reason, classifier, assets: [{ assetId, gate, outcome, txHash }] }` |
| `GET /api/price-update?asset=ETH` | `{ updates, fee }` for a manual sell: pass `updates` to `sell(id, 0, updates)` with `fee` wei |
| `POST /api/demo/faucet` `{ address }` | Base Sepolia ETH and mock USDC, once per address per UTC day, at most `FAUCET_MAX_PER_DAY` in all |
| `GET /api/tamper-set?asset=ETH` | a fresh Pyth update and its forgeries, for the judges' page |
| `GET /api/state`, `/api/stream` | the console's explanation log |

`verdict` is `relevant`, `not-relevant` or `skipped-by-filter`; `outcome` is `opened`, `bought`, `expired` or the vault's
error name. `assetId` is the asset key, such as `ETH`. `shared/pyth/manual-sell.mts` shows the manual sell from
TypeScript.

## Commands

| Command | What it does |
| --- | --- |
| `npm run export-abi` | Copies the compiled ABIs for the agent and the frontend |
| `npm run set-rule` | Funds a user and sets their rule (`USER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`) |
| `npm run add-account -- <handle>` | Registers an account on the deployed vault (`OWNER_PRIVATE_KEY`, the deployer's key) |
| `npm run tamper-demo` | A fresh Pyth update and its forgeries, judged by the deployed vault's `checkPrice`: no wallet, no gas; without `RPC_URL` or a deployment, by the in-memory vault |
| `npm run pyth-fixtures` | Rewrites `shared/fixtures/pyth/` from the Base Sepolia transactions that carry them |
| `npm run wallets` | The agent and faucet wallets, their checks, and what polling costs a day on the schedule |
| `npm run run-report` | A live run's evidence from `.data/events.jsonl`: hours, transactions, costs |
| `npm run local-stage -- <open\|confirm\|sell\|expire\|serve-prices>` | Plays the agent on a local anvil |
| `npm run typecheck` | `tsc` over sources, scripts, tests and `shared/pyth` |

## What it costs

Running cost for one watched account, a quiet day (no posts):

| | Hackathon | v2 |
| --- | --- | --- |
| Posts | TwitterAPI.io Airnode, 0.01 aUSD per call, polled every 60 s: 1,440 calls, **about $14.40** | GetXAPI at $0.001 a call, polled every minute in US market hours and every 15 min otherwise: about 356 calls, **about $0.36** (TwitterAPI.io: about $0.05) |
| Prices | Nodary free, TickerLayer 0.05 aUSD a call for stocks and oil | Pyth: Hermes by API key, plus 10 wei per price on-chain |
| Model | every post to Claude Opus | the keyword filter drops posts that name no topic; Haiku 5.5 reads the rest (about $0.0002 a post), Opus 5.5 only when Haiku is unsure; no post is read twice |

These v2 figures are computed from the providers' per-call prices and the schedule (`npm run wallets` prints them for
the live watch set), not yet measured on a live run. Once live, `GET /api/costs` and `npm run run-report` show the
measured numbers, per user and day.

## How it handles failure

- Every write is simulated first; a revert comes back as the vault's error name (`SpikeTooHigh`, `PriceTooOld` and so
  on) and is final for that post and asset.
- A passing outage (the post provider, Claude's API, Hermes, the RPC) is retried on the next poll while the post is
  still young enough for the vault (30 minutes). The classification is kept, and assets that already opened are not
  opened again.
- A refusal or unusable answer from the model means "not relevant": nothing is triggered on a guess.
- A rule change takes effect on the next pass: open triggers wait under the new rule's window, or expire at once when
  the asset left the rule; open positions keep the exits they were bought with.
- A source that keeps failing is skipped for a while; a daily USD budget for data and an ETH budget for gas put the
  agent in saving or halted mode.

## Hosting

`Dockerfile` and `fly.toml` at the repository root run `npm run live:supervised` on one small always-on Fly.io machine
(shared-cpu-1x, 512 MB, about $3 a month) with a 1 GB volume for `DATA_DIR`. Fly terminates HTTPS and polls
`/api/health`. Keys go in `fly secrets`; see the comments in `fly.toml`. Railway works the same way but its smallest
always-on service costs several times more.
