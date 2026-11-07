# FENA
The AI proposes, the contract decides: a trading vault that acts on posts only after verified prices prove the move.

A vault that invests for you when someone you watch posts about one of your assets, but only after Pyth prices confirm
the market moved your way. An agent reads the posts and asks; the vault has the Pyth contract verify every price, and
checks every time window, limit and rule itself, so the agent can never trade on a guess.

FENA began as a 30-hour API3 hackathon project on Airnode-signed data ([what it was](docs/hackathon/write-up.md)). v2
moves prices to Pyth (stocks, ETFs, oil and crypto), cuts the running cost from about $14 a day per watched account to
well under a dollar, and adds stop-loss, a manual sell that needs no agent, a cost meter and a decision log. The plan is
in [docs/specs](docs/specs/00-overview.md).

## Who it's for

Posts from a few people can move a market within minutes. Someone with a day job can't react in time, and an ordinary AI
trading bot asks them to hand over their money and trust its judgment. FENA is for that person. They set a rule once:
who to watch, which assets, how much, when to take profit and where to stop a loss. The vault holds the money and
enforces the rule, and the AI can only ask.

## How it works

1. **Rule:** a user deposits mock USDC and sets a rule that names the agent's wallet.
2. **Post:** the agent polls each watched account (GetXAPI or TwitterAPI.io), often in market hours, rarely at night.
3. **Meaning:** a keyword filter drops posts that name no topic; Claude Haiku reads the rest, Claude Opus only when Haiku
   is unsure. It can only say yes or no.
4. **Gate 1:** the agent brings the post's ID and P0, which must be **the first Pyth price published at or after the
   post** and at most 10 minutes after it. The vault opens a price check.
5. **Gate 2:** anyone brings a later Pyth price, P1. The vault buys only if the rise falls inside the rule's range and
   window, and within its limits. Otherwise nothing moves.
6. **Exit:** anyone may sell at the take-profit level, at the stop-loss line or when the price stagnates; the owner may
   sell by hand at any fresh price. A position keeps the exits it was bought with.

Every Pyth price is checked by the Pyth contract itself: an edited, old, replayed or wrong-asset update is refused with a
named error. The agent books each paid action to the users it served (`GET /api/costs`) and logs what happened to each
post (`GET /api/decisions`).

### Posts are not signed

The hackathon read posts through a signing Airnode; v2 reads them from a cheaper API that signs nothing, so the vault
cannot prove a post is real. It takes the post's time from its tweet ID and trusts the agent wallet the user approved
that the post exists, but only for 30 minutes. A fake post can therefore at most **open a price check**: the vault still
buys only if the first Pyth price after that moment and a later one show the rise the rule asks for. A compromised agent
gains the choice of a moment in the last 30 minutes, never the choice of price, and never the user's money.

## Try it

Needs Foundry, Node 22.18+ and Python 3. No keys, no wallet. `npm start` keeps running, so use a second terminal for the
last command:

```bash
git clone --recurse-submodules https://github.com/firatyondem/FENA-VOL2.git && cd FENA-VOL2
(cd contracts && npm ci && forge test)
(cd agent && npm install && npm test)
(cd agent && npm start)
python -m http.server 8000
```

1. Gets the code with the contracts' libraries.
2. Installs the Pyth SDK and runs the vault's tests. `test/fork` runs against the real Pyth contract on a fork of Base
   Sepolia through a public RPC; offline, add `--no-match-path "test/fork/*"`.
3. Runs the agent's tests (`npm run test:e2e` adds the agent against the vault on a local anvil).
4. Starts the agent's Wire Desk in replay mode at http://127.0.0.1:4173: a run from post to sale against an in-memory
   copy of the vault, then the four forgeries it refuses.
5. Serves the app: http://localhost:8000/frontend/ opens practice mode.

## Deployed

The v2 vault is **not deployed yet**. The live app and the vault below are the hackathon's, on Airnode-signed data:

| | |
| --- | --- |
| Live app | [niclas488.github.io/API3-FENA](https://niclas488.github.io/API3-FENA/) |
| Network | Base Sepolia (chain id 84532) |
| Hackathon vault | [`0xcf3f62D4316e5162777B34a8722798d2eBA017f5`](https://sepolia.basescan.org/address/0xcf3f62D4316e5162777B34a8722798d2eBA017f5) |

v2 deploys with `forge script Deploy` (see [agent/README.md](agent/README.md#deploy-and-go-live)) against Base Sepolia's
Pyth contract `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`; the agent runs on one small Fly.io machine
([fly.toml](fly.toml)).

## Running cost

One watched account on a quiet day: about **$14.40** in the hackathon (a paid Airnode call every minute), about **$0.36**
in v2 with GetXAPI on the smart-poll schedule, or about **$0.05** with TwitterAPI.io. Model calls add about $0.0002 per
post that names a topic. These v2 numbers are computed from the providers' prices; the cost ledger measures them on a
live run. Details in [agent/README.md](agent/README.md#what-it-costs).

## Going further

| To | See |
| --- | --- |
| Deploy and run the agent live, its HTTP API and its costs | [agent/README.md](agent/README.md) |
| Sell by hand from the website, with no agent in the loop | [shared/pyth/manual-sell.mts](shared/pyth/manual-sell.mts) |
| The real Pyth updates the tests use | [shared/fixtures/README.md](shared/fixtures/README.md) |
| Run the app against a real vault on a local chain | [frontend/README.md](frontend/README.md#rehearse-live-mode-on-anvil) |
| The v2 plan and each person's part | [docs/specs](docs/specs/00-overview.md) |
| The hackathon's specs and write-up | [docs/hackathon](docs/hackathon/write-up.md) |

## Layout

| Folder | Holds |
| --- | --- |
| `contracts/` | The `Vault` (Foundry), its tests, mocks (`LocalPyth` for local chains) and the deploy script |
| `agent/` | The agent: post sources, Claude relevance check, Pyth prices, sell keeper, cost ledger, decision log, HTTP API |
| `frontend/` | The app: plain HTML and JavaScript, practice and live mode |
| `shared/` | What they share: asset profiles with Pyth feeds, deployments, ABIs, Pyth fixtures, the manual-sell helper |
