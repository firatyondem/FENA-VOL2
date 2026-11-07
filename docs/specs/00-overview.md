# FENA v2: overview and split

FENA started as a 30-hour hackathon project on API3 Airnodes. v2 turns it into a working website that is cheap to run.
The core idea stays the same: **the AI proposes, the contract decides.** The agent can only ask; the vault only acts on
prices it verifies itself.

This file is for both of us. Each person then has their own spec:

- [01-person-a-chain-and-agent.md](01-person-a-chain-and-agent.md): contract, data sources, agent, hosting
- [02-person-b-app-and-product.md](02-person-b-app-and-product.md): website, wallet, demo, strategy editing, backtesting

## What v2 adds

| # | Feature | Owner |
| --- | --- | --- |
| 1 | Signed prices from **Pyth** instead of Airnodes (stocks, ETFs, oil, crypto) | A |
| 2 | Cheaper post source (**GetXAPI** or **TwitterAPI.io** directly) and lower running costs | A |
| 3 | **Stop-loss** enforced by the vault, not only by the agent | A |
| 4 | **Manual sell** that always works, without the agent's console | A (contract), B (UI) |
| 5 | **Cost meter**: what each rule costs per day | A (data), B (UI) |
| 6 | **Decision log**: for every post, what the AI said and why a trade did or didn't happen | A (data), B (UI) |
| 7 | Agent **hosted 24/7** | A |
| 8 | **Login without MetaMask** (Coinbase Smart Wallet, passkeys) | B |
| 9 | **Demo without any wallet** that still uses the real contract | B (A adds a faucet endpoint) |
| 10 | **Change your strategy** after setting it (this did not work in the hackathon version) | B (A fixes the agent side) |
| 11 | **Backtesting**: what would this rule have earned on past posts and prices | B |

Out of scope: real money, a real DEX, mainnet. It stays a Base Sepolia testnet app with mock tokens.

## How we hand work to each other

Person A owns the contract and the agent's HTTP API. Person B owns the website. Both build against the interfaces below.
**Agree on them in the first two days**, then each side can work alone, with mocks for the other side.

### Contract changes B depends on

```solidity
// Prices are now Pyth price updates, not Airnode responses.
// Every function that took a SignedResponse price takes `bytes[] calldata priceUpdate` instead and is payable,
// because Pyth charges a small update fee (pyth.getUpdateFee(priceUpdate)).
function sell(uint256 positionId, SellReason reason, bytes[] calldata priceUpdate) external payable;

enum SellReason { Manual, TakeProfit, Stagnation, StopLoss }   // StopLoss is new

// AssetRule gets one new field
uint16 stopLossBps;   // anyone can sell when P <= entry * (1 - stop-loss). 0 turns it off.
```

A publishes the new ABI to `shared/deployments/abi/` and the address to `shared/deployments/84532.json` after each deploy.

### Agent HTTP API B depends on

All JSON, served by the agent over HTTPS with CORS open to the website's origin.

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | `{ ok, lastPollAt, version }` |
| `GET /api/costs?user=0x..&days=7` | per day: `{ date, posts, aiCalls, priceUpdates, gasWei, totalUsd }` and a per-source breakdown |
| `GET /api/decisions?user=0x..&limit=50` | per post: `{ tweetId, account, text, createdAt, verdict, reason, assets: [{ assetId, gate, outcome, txHash }] }` |
| `POST /api/demo/faucet` body `{ address }` | sends test ETH and mUSDC to a demo address, at most once per address per day |

`verdict` is `relevant` / `not-relevant` / `skipped-by-filter`. `outcome` is one of the vault's error names
(`BelowThreshold`, `SpikeTooHigh`, `PriceTooOld`, ...) or `opened`, `bought`, `expired`.

Until A's endpoints are live, B uses fixture files with exactly these shapes in `frontend/fixtures/`.

## Timeline (two weeks)

| When | Person A | Person B |
| --- | --- | --- |
| Days 1–2 | New repo, agree on the interfaces above | Same |
| Week 1 | Pyth in the vault, stop-loss, new post API, cost ledger | Smart Wallet login, demo mode, strategy editing |
| Week 2 | Decision log, cost cuts, hosting, deploy | Manual sell UI, cost and decision pages, backtesting |
| Last 2 days | End-to-end test together, README, new demo video | Same |

Merge to `main` only through pull requests that the other person has reviewed. CI runs `forge test`, the agent's
`npm test` and `npm run typecheck`.

## Setting up the new repo

Keep the git history: it shows who built what, which matters when either of us talks about this project in an interview.

1. Ask Ada, Erika and Niclas if they're fine with us continuing the project in a new repo, and credit them in the README.
2. On GitHub, create an **empty** repo (no README, no license), e.g. `fena`.
3. Copy everything with history:

   ```bash
   git clone --bare https://github.com/niclas488/API3-FENA.git
   cd API3-FENA.git
   git push --mirror https://github.com/<owner>/fena.git
   cd .. && rm -rf API3-FENA.git
   git clone --recurse-submodules https://github.com/<owner>/fena.git
   ```

4. Add the other person as a collaborator, protect `main`, and add a `LICENSE` file (the agent's package already says
   MIT).
5. Put these three spec files in `docs/specs/`.
6. Move the hackathon docs (`docs/spec-person-a.md`, `docs/write-up.md`, ...) to `docs/hackathon/` so it's clear what
   is old.

## How we measure success

- Running cost for one watched account polled all day: from about €14 a day in the hackathon to **under €1 a day**.
- A visitor with no wallet can go from the landing page to a real buy and a manual sell on Base Sepolia in under
  five minutes.
- The tamper test still passes: an edited, old or wrong-asset price update is refused by the vault.
- A backtest of the default rule over the last three months, with its result written honestly in the README, even
  if it lost money.
