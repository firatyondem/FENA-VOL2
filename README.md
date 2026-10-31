# API3-FENA
The AI proposes, the contract decides: a trading vault that acts on posts only after signed data proves the move.

**[Try the live app](https://niclas488.github.io/API3-FENA/), no wallet needed.**

A vault that invests for you when someone you watch posts about one of your assets, but only after a signed price
confirms the market moved your way. An agent reads the posts and brings API3 Airnode-signed proof; the vault checks
every signature, request, timestamp and limit itself, so the agent can never trade on a guess.

## Who it's for

Posts from a few people can move a market within minutes. Someone with a day job can't react in time, and an ordinary AI
trading bot asks them to hand over their money and trust its judgment. FENA is for that person. They set a rule once:
who to watch, which assets, how much. The vault holds the money and enforces the rule, and the AI can only ask.

Without a valid signed AirnodeHub response there is no trade, so forged data, a buggy agent or a hacked agent all end in
a refused transaction. See [who relies on the data and what forging it would do](docs/write-up.md).

## How it works

1. **Rule:** a user deposits mock USDC and sets a rule that names the agent's wallet.
2. **Post:** about once a minute, the agent pays over x402 for the watched account's newest post, signed by the
   TwitterAPI.io Airnode.
3. **Meaning:** Claude decides whether the post matters for the user's assets. It can only say yes or no.
4. **Gate 1:** the agent brings the signed post and a signed price, P0. The vault checks both and opens a price check.
5. **Gate 2:** the agent brings later signed prices, P1. The vault buys only if the rise falls inside the rule's range and
   window, and within its limits. Otherwise nothing moves.
6. **Exit:** the agent sells at the take-profit level or when the price stagnates, again with a signed price.

The agent repeats this on its own schedule, with daily spending limits, and restarts itself after a crash. See
[how it handles failure](agent/README.md#how-it-handles-failure).

## Try it in five commands

Needs Foundry, Node 22.18+ and Python 3. No keys, no wallet. `npm start` keeps running, so use a second terminal for the
last command:

```bash
git clone --recurse-submodules https://github.com/niclas488/API3-FENA.git && cd API3-FENA
(cd contracts && forge test)
(cd agent && npm install && npm test)
(cd agent && npm start)
python -m http.server 8000
```

1. Gets the code with the contracts' libraries.
2. Runs the vault's tests.
3. Runs the agent's tests.
4. Starts the agent's Wire Desk in replay mode at http://127.0.0.1:4173: a real run from post to sale against an
   in-memory copy of the vault, then the four forgeries it refuses.
5. Serves the app: http://localhost:8000/frontend/ opens practice mode, where you play example posts yourself.

## Deployed

| | |
| --- | --- |
| Live app | [niclas488.github.io/API3-FENA](https://niclas488.github.io/API3-FENA/) |
| Network | Base Sepolia (chain id 84532) |
| Vault | [`0xcf3f62D4316e5162777B34a8722798d2eBA017f5`](https://sepolia.basescan.org/address/0xcf3f62D4316e5162777B34a8722798d2eBA017f5) |
| Deployed at block | 52460329 |
| Verified source | [Blockscout](https://base-sepolia.blockscout.com/address/0xcf3f62D4316e5162777B34a8722798d2eBA017f5?tab=contract), exact match on Sourcify |

The mock USDC, DEX and asset tokens are in [shared/deployments/84532.json](shared/deployments/84532.json). This deployment
is a demo: the tokens and the DEX are mocks, the wait is 2 minutes, and the ETH profile allows a rise of 0.5 % where the
spec uses 3 %, so that a trade can finish during a live run.

### Test the deployed vault yourself

The [live app](https://niclas488.github.io/API3-FENA/) opens on the judges' page. Its buttons send a real signed price and
four forgeries of it to the vault, and you can paste your own signed response. The "Live on the vault" feed there lists
every price check, buy and sale from the chain, with its transaction. All of this needs no wallet and no gas: the vault's
read-only `checkPrice` runs the same check as every buy and sell, and nothing can move.

The same test from a terminal, naming the vault's error for each forgery:

```bash
cd agent && npm install && RPC_URL=https://base-sepolia-rpc.publicnode.com npm run tamper-demo
```

To test your own signed response:

```bash
RPC_URL=https://base-sepolia-rpc.publicnode.com npm run tamper-demo -- --response my.json --asset ETH
```

A real buy goes through `confirmTrigger`, which runs the same check and then moves the money. Those transactions appear
in the feed. To deposit, withdraw or set a rule yourself, connect a wallet with a little Base Sepolia ETH; mUSDC comes from
the button on the Money tab.

## Going further

| To | See |
| --- | --- |
| Run the app against a real vault on a local chain, step by step | [frontend/README.md](frontend/README.md#rehearse-live-mode-on-anvil) |
| Deploy to Base Sepolia and run the agent live | [agent/README.md](agent/README.md#deploy-and-go-live) |
| Read who relies on the data and what forging it would do | [docs/write-up.md](docs/write-up.md) |
| Read how the agent runs on its own | [docs/spec-agent-autonomy.md](docs/spec-agent-autonomy.md) |
| Read the contract spec | [docs/spec-person-a.md](docs/spec-person-a.md) |

## Layout

| Folder | Holds |
| --- | --- |
| `contracts/` | The `Vault` (Foundry), its tests, mocks and the deploy script |
| `agent/` | The agent: post reader, Claude relevance check, signed-price fetcher, sell keeper, Wire Desk console |
| `frontend/` | The app: plain HTML and JavaScript, practice and live mode |
| `shared/` | What the three share: asset profiles, deployments, ABIs, signed fixtures |
