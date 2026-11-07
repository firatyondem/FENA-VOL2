# Spec: Person B, website and product

Read [00-overview.md](00-overview.md) first: it has the contract changes and agent API you build against. Until
Person A's endpoints are live, use fixture files with the same shapes in `frontend/fixtures/`.

The website is plain HTML and JavaScript (`frontend/`), hosted on GitHub Pages. Keep it that way unless a feature
really needs a build step; if one does, agree with A first.

## B1. Login without MetaMask (week 1)

- Replace the MetaMask-only connect (`frontend/js/chain.js`, the `NoWallet` path in `app.js`) with **Coinbase Smart
  Wallet**: login with a passkey (Face ID, fingerprint), no extension, no seed phrase. Its SDK is free and
  open-source, and it runs on Base.
- Keep "connect an existing wallet" as a second option for people who have one.
- Look into Coinbase's paymaster on Base Sepolia so users don't need test ETH for gas. If it takes more than a day,
  skip it: the faucet (B2) covers gas for the demo.

**Done when:** a new user can log in with a passkey, deposit mUSDC from the Money tab and set a rule without
installing anything.

## B2. Demo without any wallet (week 1)

Two levels:
1. **Practice mode** (already exists): mock data in the browser, works offline. Keep it as the fallback.
2. **Live demo (new):** one click creates a throwaway key in the browser (`localStorage`), calls
   `POST /api/demo/faucet` to fund it, then lets the visitor set a rule and see real transactions on Base Sepolia.
   - Show clearly that it's a test account with test money and that the key lives only in this browser.
   - "Reset demo" deletes the key.

**Done when:** someone with no wallet gets from the landing page to a real buy and a manual sell in under five
minutes. Time it with someone who hasn't seen the app.

## B3. Change your strategy (week 1)

In the hackathon version, changing a rule after setting it didn't work. First **find out why**: reproduce it on a
local chain (see `frontend/README.md`, "Rehearse live mode on Anvil") and note whether the transaction reverts, the UI
doesn't send it, or the agent ignores the new rule. Tell A if it's the agent side (A8).

Then build a proper editor:
- Open the current rule pre-filled (read it from the vault with `getRule` / `getAssetRule`).
- Edit everything: watched accounts, assets, buy amount, limits, threshold, wait, take-profit, **stop-loss** (new),
  stagnation.
- Show the profile limits next to each field, so the user can't build a rule the vault will reject.
- Explain before saving what happens to open price checks and open positions.
- "Pause" and "resume" buttons (`setPaused` already exists).

## B4. Manual sell (week 2)

Once A3 is deployed, "Sell now" fetches a Pyth price update from Hermes directly, shows the price and the expected
mUSDC back, then calls `sell(positionId, Manual, update)` with the update fee. It must work even when the agent is
offline. Replace the console dependency in `sellControlsLive` / `quoteSell` (`frontend/js/app.js`). Show stop-loss
sales in the history with their own label.

## B5. Cost page (week 2)

From `GET /api/costs`: today's cost and the last 7 days for the user's rule, split by posts, AI, price updates and
gas, plus a projected cost per month. Add a short note on why it's cheap (shared polling, filtering).

## B6. Decision log page (week 2)

From `GET /api/decisions`: a feed of posts with the AI's verdict and reason, and per asset what happened, with a link
to the transaction. Use plain words for the vault's errors ("the price didn't rise enough", "the price was too old").
Filters: only relevant posts, only trades.

## B7. Backtesting (week 2)

The question it answers honestly: **would this rule have made money?**

1. **Data script** (`backtest/fetch.ts`): for 3–5 watched accounts, download about three months of posts once
   (through A's post interface, so it costs a few cents) and price history for the assets (Alpaca's free tier for
   stocks and ETFs; Pyth's Hermes history or another free source for crypto). Save it as JSON in `backtest/data/`.
2. **Engine** (`backtest/run.ts`): replay the posts in order and use the **agent's own gate and keeper code**
   (`agent/src/engine/gates.ts`, `keeper.ts`), not a copy, so the backtest follows exactly the same rules as live
   trading. Use the keyword filter or cached AI verdicts, so a backtest run costs nothing.
3. **Output:** every simulated trade with entry, exit and reason, total return, win rate, largest loss, and the same
   period's return of simply holding the asset, for comparison.
4. **Page:** pick accounts, assets and rule values, run on the saved data in the browser, and show a chart and the
   trade list.

**Done when:** the default rule's three-month result is in the README, even if it lost money.

## Order

B1 → B2 → B3 (week 1, with fixtures where A isn't ready) → B4 → B5 → B6 → B7 (week 2). Backtesting is the biggest
piece: if week 2 gets tight, ship steps 1–3 as a command-line tool and add the page afterwards.
