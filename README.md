# API3-FENA
LLM-analyzed X posts → trades via mock/Coinbase

A vault that invests for you when someone you watch posts about one of your assets, but only after a signed price
confirms the market moved your way. An agent reads the posts and brings API3 Airnode-signed proof; the vault checks
every signature, request, timestamp and limit itself, so the agent can never trade on a guess.

## Try it in five commands

Needs Foundry, Node 22.18+ and Python 3. No keys, no wallet:

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
| Network | Base Sepolia (chain id 84532) |
| Vault | [`0xcf3f62D4316e5162777B34a8722798d2eBA017f5`](https://sepolia.basescan.org/address/0xcf3f62D4316e5162777B34a8722798d2eBA017f5) |
| Deployed at block | 52460329 |
| Verified source | [Blockscout](https://base-sepolia.blockscout.com/address/0xcf3f62D4316e5162777B34a8722798d2eBA017f5?tab=contract), exact match on Sourcify |

The mock USDC, DEX and asset tokens are in [shared/deployments/84532.json](shared/deployments/84532.json).

Test the deployed vault yourself. Its read-only `checkPrice` runs the same check as every buy and sell, so this needs no
wallet and no gas, and nothing can move:

```bash
cd agent && npm install && RPC_URL=https://sepolia.base.org npm run tamper-demo
```

It accepts a fresh signed price and refuses four forgeries of it, naming the vault's error for each. To test your own
response, add `-- --response my.json --asset ETH`, or paste it into the app: open
http://localhost:8000/frontend/?mode=live&chain=84532 and pick "For judges: test the vault without a wallet".

## Going further

| To | See |
| --- | --- |
| Run the app against a real vault on a local chain, step by step | [frontend/README.md](frontend/README.md#rehearse-live-mode-on-anvil) |
| Deploy to Base Sepolia and run the agent live | [agent/README.md](agent/README.md#deploy-and-go-live) |
| Read who relies on the data and what forging it would do | [docs/write-up.md](docs/write-up.md) |
| Read the contract spec | [docs/spec-person-a.md](docs/spec-person-a.md) |

## Layout

| Folder | Holds |
| --- | --- |
| `contracts/` | The `Vault` (Foundry), its tests, mocks and the deploy script |
| `agent/` | The agent: post reader, Claude relevance check, signed-price fetcher, sell keeper, Wire Desk console |
| `frontend/` | The app: plain HTML and JavaScript, practice and live mode |
| `shared/` | What the three share: asset profiles, deployments, ABIs, signed fixtures |
