# Frontend: Signal Vault

The user interface for the vault: connect, set a rule, deposit and withdraw, watch posts go through both checks, see the investment history, and run the tamper test (footer link "For judges").

## Run it

No build step. Serve the **repo root**, because live mode reads `../shared/deployments/`:

```bash
python -m http.server 8000
```

Then open http://localhost:8000/frontend/. (`npx --yes serve -l 8000 .` works too, but needs a download; Python's
server needs nothing.)

The only library is ethers v6, vendored in `vendor/ethers.umd.min.js` (version and source in its first line), so the
page needs no CDN.

## Two modes

| | Practice (default) | Live (`?mode=live`) |
| --- | --- | --- |
| Vault | `js/mock.js` in the browser, same checks | the deployed `Vault`, through your wallet |
| Money | play mUSDC | mUSDC, a free test token (button "Get 10,000 test mUSDC") |
| Posts and prices | example posts you play yourself | the agent's posts and signed prices, read from the vault's events |
| Login | username and password, stored in the browser | your wallet address |

`?chain=84532` picks Base Sepolia instead of the local chain. Both defaults sit in the "Live mode" section of
`js/config.js` (`DEFAULT_MODE`, `DEFAULT_CHAIN_ID`), with each network's RPC, agent wallet and agent console in
`NETWORKS`.

What live mode shows:

- **Your rule** loads the rule saved on-chain and saves changes with `setRule`; limits come from the vault's asset
  profiles, and every problem the vault would refuse is caught before the wallet opens.
- **Money**: deposit (approve, then deposit: two wallet prompts), withdraw, wallet and vault balances, today's budget.
- **Activity**: each post that opened a price check (time from its X id, link to the post, the AI's reason when the
  agent's console is reachable), each price check with its window on the chain's clock, and the latest results. A
  check whose window closed gets a "Close it (expire)" button; anyone may expire one.
- **History**: every position with cost, entry, exit, proceeds and why it was sold, plus the transactions as proof. An
  open position is valued at the last price the vault verified, with its age; the page never makes up a price. "Sell
  now" fetches a signed price from the agent's console, shows it, and sells at it on a second click. Without a price
  source it stays disabled: the keeper sells at take profit or after the stagnation delay.
- **Tamper test** stays a browser simulation in both modes and says so; `npm run tamper-demo` in `agent/` sends the
  same forgeries to the real vault.

Every transaction is simulated first, so a refusal shows the vault's reason (for example "the response is too old")
before the wallet asks for anything.

## Rehearse live mode on anvil

Five terminals, all from the repo root. Only anvil's public test keys appear here: they are known to everyone, so
never send real funds to them.

**1. Chain**

```bash
anvil
```

**2. Deploy** with the public fixture signer as the price and post Airnode, so the stage driver can sign:

```bash
cd contracts && PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 FIXTURE_AIRNODES=true forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

This rewrites `shared/deployments/31337.json` with `"fixtureAirnodes": true`. Never commit that change: run
`git checkout shared/deployments/31337.json` before a commit.

**3. Page**

```bash
python -m http.server 8000
```

Open http://localhost:8000/frontend/?mode=live and click Connect wallet. MetaMask offers to add the Anvil network
(chain id 31337, RPC http://127.0.0.1:8545). Import anvil's account 2 as a test account with its public key
`0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` (address
`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`). After anvil restarts, clear MetaMask's activity for that account
(Settings, Advanced, Clear activity tab data) so its nonce starts over.

In the page: Money, "Get 10,000 test mUSDC", deposit; then Your rule: pick ETH, watch @realDonaldTrump, confirm the
values and save. The rule names anvil's account 1 as the agent, which is the stage driver's wallet.

**4. Play the agent** with the stage driver; every step shows up in the page within two seconds:

```bash
cd agent && npm run local-stage -- open --user 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --asset ETH
```

| Then | Shows |
| --- | --- |
| `npm run local-stage -- confirm --trigger 1 --move 0.5` | refused with `TrendTooWeak`; the price check stays open |
| `npm run local-stage -- confirm --trigger 1 --move 3.5` | bought: Activity says invested, History has the position |
| `npm run local-stage -- sell --position 1 --move 9 --reason takeprofit` | sold at take profit, with the proceeds |
| `open` again, then `expire --trigger 2` | expired; or wait for the window and click "Close it (expire)" |

The driver moves anvil's clock instead of waiting. A fall needs the `=` form: `--move=-2`.

**5. Signed prices** for "Sell now" in History:

```bash
cd agent && npm run local-stage -- serve-prices --move 2
```

It answers `/api/signed-price` on port 4173 like the agent's console does in live mode, signing the asset's newest
on-chain price moved by `--move`. The agent's console uses the same port, so run one or the other. The AI's reasons in
Activity come from a live agent (`AGENT_MODE=live npm start` with `agent/.env` set for anvil); posts from the stage
driver never went through it, so they show without one.

## Go live on Base Sepolia

After the deploy and `set-rule` in `agent/README.md`:

1. Put the agent's wallet address in `NETWORKS[84532].agent` in `js/config.js`.
2. Run the agent with `AGENT_MODE=live`, and add the page's origin to `CONSOLE_ALLOWED_ORIGINS` in `agent/.env` if it
   isn't http://localhost:8000.
3. Open `?mode=live&chain=84532`, or set `DEFAULT_MODE = "live"` and `DEFAULT_CHAIN_ID = 84532` for the demo.

Users need a little Base Sepolia ETH for gas; mUSDC comes from the faucet button.

## Tests

From the repo root, after `npm install` in `agent/` (the tests compare against the agent's own code):

```bash
node --test "frontend/test/*.test.mjs"
```

They cover every conversion in `js/units.js`: USDC and price decimals, basis points, times, asset ids, a post's time
from its id, the signed response sent to the vault, and `setRule`'s arguments, which must equal what the agent's
`set-rule` script sends.

## Files

| File | Holds |
| --- | --- |
| `index.html` | Page layout: login, tabs, footer |
| `css/style.css` | Colours and layout |
| `js/config.js` | Asset profiles, watched accounts, topics, limits, mode and networks |
| `js/mock.js` | Practice contract and agent |
| `js/units.js` | Every conversion between the page and the contracts |
| `js/chain.js` | Live mode: deployment, wallet, transactions, the vault's state from its events |
| `js/app.js` | Everything the page does, in both modes |
| `vendor/ethers.umd.min.js` | ethers v6, vendored |
| `test/units.test.mjs` | Unit tests for `js/units.js` |
