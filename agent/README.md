# Agent, mocks and deployment (Person B)

The agent notices posts, filters noise and brings signed proof to Person A's vault. It never predicts and never holds
funds: the worst a wrong or malicious agent can do is submit a trigger the vault rejects.

```
post (signed, TwitterAPI.io Airnode) ──> relevance check (Claude) ──> openTrigger(user, asset, post, P0)   Gate 1
                                                                  └─> confirmTrigger(trigger, P1)          Gate 2
signed price (Nodary / TickerLayer) ──> sell keeper ──────────────> sell(take profit | stagnation)
```

## Run it

Needs Node 22.18+ (it runs the `.ts` sources directly) and Foundry.

```sh
cd agent
npm install
npm test           # unit tests, no network
npm run test:e2e   # the agent against the real Vault on a local anvil (needs anvil and forge on PATH)
npm start          # The Wire Desk console at http://127.0.0.1:4173, replay mode
```

`npm start` without keys runs the **stage replay**: the real engine, classifier and keeper against an in-memory copy of
the vault's checks, fed with signed fixtures on a 10x clock. It shows one valid run (an oil buy at the signed P1, then a
take-profit sell) and the four tamper rejections. With `ANTHROPIC_API_KEY` set, Claude classifies the posts instead of
the keyword baseline; the Ðogecoin post shows the difference.

## Deploy and go live

From `contracts/`, after `npm run request-hashes` in `agent/`:

```sh
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast   # PRIVATE_KEY in the environment
```

`Deploy.s.sol` deploys mock USDC, the mock DEX, tOIL, tDOGE, tETH, tBTC, tTSLA and the `Vault`, registers every asset
profile (asset id `keccak256("OIL")`, its price Airnode and request hash, the spec's limits with a 2-minute demo wait)
and every watched account, and writes the addresses to `shared/deployments/<chain id>.json`. `DEMO_WAITS=false` keeps
the spec's 30 min to 1 h waits; `FIXTURE_AIRNODES=true` registers the public fixture key for local tests.

Then, in `agent/` with `.env` filled in (see `.env.example`):

```sh
npm run export-abi   # after any vault change: ABIs to shared/deployments/abi/, types to src/chain/vault-abi.ts
npm run set-rule     # the demo user deposits mock USDC and sets config/rule.example.json with this agent
AGENT_MODE=live npm start
```

In live mode the agent reads its users from the vault: everyone whose latest `RuleSet` names its wallet, with their
assets, limits, watched accounts and topics. It finds open positions from `TriggerConfirmed`, so a restart loses none.

| Command | What it does |
| --- | --- |
| `npm run fixtures` | Regenerates the signed fixtures in `shared/fixtures/synthetic/` |
| `npm run request-hashes` | Writes the hashes the deploy registers to `shared/deployments/request-hashes.json` |
| `npm run export-abi` | Copies the compiled ABIs for the agent and the frontend |
| `npm run set-rule` | Funds a user and sets their rule (`USER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`) |
| `npm run fetch-prices -- ETH OIL --save` | Fetches and verifies live signed prices |
| `npm run tamper-demo` | The four forgeries against the deployed vault (`TRIGGER_ID`) or the in-memory vault |
| `npm run typecheck` | `tsc` over sources, scripts and tests |

## How it handles failure

- Every write is simulated first; a revert comes back as the vault's error name (`SpikeTooHigh`, `NotSignedByAirnode`
  and so on) and is final for that post and asset.
- A passing outage (Claude's API, a price fetch, the RPC) is retried on the next poll while the post is still young
  enough for a P0. The classification is kept, and assets that already opened are not opened again.
- A refusal or unusable answer from the model means "not relevant": nothing is triggered on a guess.

## Hand-offs to Person A

- **MockDEX** implements `IMockDEX`: anyone may call, buy pulls USDC, sell pulls the asset and mints USDC.
- **Fixtures**: `shared/fixtures/` (see its README). `FixtureTamperTest` reads `nodary-eth-usd.json` and passes.
- **Deployment**: `contracts/script/Deploy.s.sol`; addresses in `shared/deployments/<chain id>.json`, ABIs in
  `shared/deployments/abi/`.

## Still open

- Deploying to Base Sepolia needs a funded deployer key (testnet ETH).
- One paid call per account and per TickerLayer asset (needs `PAYER_PRIVATE_KEY` with aUSD) to confirm the handles and
  pinned-tweet flags in `config/watchlist.json` and the unit of TickerLayer's `lastTrade.timestamp` (assumed ms);
  `npm run fetch-prices -- OIL TSLA --save` keeps the responses.
- The deployed vault has no stop loss; the keeper only offers take profit and the stagnation exit on-chain.
