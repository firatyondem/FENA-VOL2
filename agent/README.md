# Agent, mocks and deployment (Person B)

The agent notices posts, filters noise and brings signed proof to the vault. It never predicts and never holds funds:
the worst a wrong or malicious agent can do is submit a trigger the vault rejects.

```
post (signed, TwitterAPI.io Airnode) ──> relevance check (Claude) ──> openTrigger(post, P0)   Gate 1
                                                                  └─> confirmTrigger(P1)      Gate 2, after the window opens
signed price (Nodary / TickerLayer) ──> sell keeper ──────────────> sell(take profit, stagnation, stop loss)
```

## Run it

Needs Node 22.18+ (it runs the `.ts` sources directly) and, for the contracts, Foundry.

```sh
cd agent
npm install
npm test          # 120+ tests, no network
npm start         # The Wire Desk console at http://127.0.0.1:4173, replay mode
```

`npm start` without keys runs the **stage replay**: the real engine, classifier and keeper against an in-memory
vault, fed with signed fixtures on a 10x clock. It shows one valid run (an oil buy at the signed P1, then a take-profit
sell) and the four tamper rejections. With `ANTHROPIC_API_KEY` set, Claude classifies the posts instead of the keyword
baseline; the Ðogecoin post shows the difference.

For **live mode**, copy `.env.example` to `.env`, copy `config/rules.example.json` to `config/rules.json` and match
the deployed rule, then `AGENT_MODE=live npm start`.

| Command | What it does |
| --- | --- |
| `npm run fixtures` | Regenerates the signed fixtures in `shared/fixtures/synthetic/` |
| `npm run request-hashes` | Writes the hashes the vault stores to `shared/deployments/request-hashes.json` |
| `npm run fetch-prices -- ETH OIL --save` | Fetches and verifies live signed prices |
| `npm run tamper-demo` | The four forgeries against the deployed vault (`VAULT_ADDRESS`, `TRIGGER_ID`) or the SimVault |
| `npm run typecheck` | `tsc` over sources, scripts and tests |

## Mocks and deployment

```sh
forge test                                   # mock token and DEX tests
PRIVATE_KEY=0x... forge script contracts/script/DeployMocks.s.sol --rpc-url $RPC_URL --broadcast
```

`DeployMocks` deploys mock USDC (6 decimals, open faucet), the mock DEX and tOIL, tDOGE, tETH, tBTC, tTSLA, and writes
their addresses to `shared/deployments/<chain id>.json`. Set `VAULT_ADDRESS` to approve an existing vault as the DEX
trader. The DEX swaps at exactly the price it is given, so only the vault may call it.

## Hand-offs to Person A

- **Fixtures**: `shared/fixtures/` (see its README). Real Nodary responses, plus synthetic tweets, P0/P1 prices and
  the four tamper cases signed by a public test key, with a manifest of expected outcomes.
- **Request hashes**: `shared/deployments/request-hashes.json`.
- **Mock addresses**: `shared/deployments/<chain id>.json`; local anvil addresses are committed.
- **Tweet time on-chain**: X ids are Snowflakes, so `(id >> 22) + 1288834974657` is the creation time in ms. That is
  simpler than parsing X's `createdAt` string, which IsoTimestamp does not read.

## Assumptions to confirm at kickoff

- `src/chain/vault-abi.ts` is a **draft** of IVault: `openTrigger(ruleId, asset, account, post, p0)`,
  `confirmTrigger(triggerId, p1)`, `expireTrigger`, `sell(positionId, kind, price)`, with each signed response passed
  as `(uint256 timestamp, bytes data, bytes signature)`, and the custom error names listed there. Replace it with the
  frozen interface and rerun the tests.
- Gate 2 times use each price's source time (`updatedAt`); the SimVault does the same.
- One post opens one trigger per rule (the first relevant asset in priority order). If the vault allows one per asset,
  the engine already tries the next asset.
- TickerLayer's `lastTrade.timestamp` unit is assumed to be milliseconds; `npm run fetch-prices -- OIL --save` with a
  payer key confirms it.
- Watched handles and pinned-tweet flags in `config/watchlist.json` should be checked with one paid call each.
