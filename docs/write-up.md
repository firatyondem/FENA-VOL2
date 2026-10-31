# Write-up: why this project needs signed data

FENA is a vault that invests for its users when someone they watch posts about one of their assets, but only after a
signed price confirms the market moved their way. An AI agent reads the posts and brings the proof. The contract checks
everything itself, so a wrong or hacked agent can only submit something that gets refused.

## Who relies on the data

| Who | What they rely on | Why they can't just trust us |
| --- | --- | --- |
| **Depositors** | That their money only moves on a real post and a real price rise, within the rule they set | They hand their funds to a contract and walk away. They never approve a single trade |
| **The vault contract** | Every price and post it acts on | It can't see X or a market. Signed responses are its only view of the outside world |
| **Anyone who keeps the vault running** | That they can submit a signed price, and that a false one fails | Confirming a buy or taking profit is open to any wallet, so the signature does the trusting, not the sender |
| **The agent's operator** | That the post it read is the post that was published | The model decides what a post means, but the post itself has to be real |

The agent is not on this list on purpose. Nothing relies on it being honest. Without a valid signed AirnodeHub response
there is no trade at all, so the integration carries the product.

## What goes wrong if the data is forged

Money would move on something that never happened. The depositor is the one who loses it.

| Forgery | Without the check | What the vault does |
| --- | --- | --- |
| **Edited price** | An attacker fakes a rise to force a buy, or inflates the price at a sell. The mock DEX pays out at the price it is given, so a raised sell price mints money that was never earned | `NotSignedByAirnode` |
| **Forged signer** | Anyone could write their own "market data" | `NotSignedByAirnode`: the vault compares the recovered signer with the Airnode it stored at deployment, never with an address the response claims |
| **Old response** | A genuine low price from days ago is replayed as P0, so today's ordinary price looks like a big rise | `ResponseTooOld`, plus `PriceTooOld` when the source's own time is stale, which a fresh signature can't hide |
| **Response to another request** | A genuine BTC price is passed off as ETH | `WrongRequestHash`: the expected hash comes from the vault's storage |
| **Same response twice** | One real price pays for several buys | `ResponseAlreadyUsed` |
| **Fake or reused post** | A made-up post spends the user's budget | Posts must be signed by the TwitterAPI.io Airnode for a watched account, and each post opens one trigger per asset. An old post can't pair with a new price |

### Test it yourself

The vault is live on Base Sepolia at
[`0xcf3f62D4316e5162777B34a8722798d2eBA017f5`](https://base-sepolia.blockscout.com/address/0xcf3f62D4316e5162777B34a8722798d2eBA017f5?tab=contract),
with verified source. Its read-only `checkPrice` runs the same `_readPrice` as every buy and sell, so you can send it any
response you like with no wallet or gas, and nothing can move:

```bash
cd agent && npm install && RPC_URL=https://sepolia.base.org npm run tamper-demo
```

Or paste your own response into the app's "For judges" page. On the deployed vault, a fresh Nodary price was accepted
and the four forgeries above were refused with those error names. The replay check belongs to a buy, so `forge test`
covers it. 384 contract tests, 145 agent tests and 9 end-to-end tests pass.

### What signatures do not protect against

- **The AI's reading is not signed.** Only the wallet a user approved may say a post is relevant. A compromised agent
  could open triggers for watched accounts and allowed assets, but the signed trend check and the user's limits still
  apply, and it can't withdraw or sell to itself. A signed model answer would remove this trust.
- **A submitter can choose among real prices.** Any genuine response from the last five minutes is valid, so someone
  can pick the most favourable one. This is limited to real prices inside that window.
- **We trust the Airnode's source.** A signature proves who said it and that it wasn't changed, not that the market data
  was right. Each asset uses one source, so a bad feed is not cross-checked; comparing two listings is on our roadmap.
- **No proof of cause.** The vault checks the user's rule. It does not claim the post moved the price.
- **Mock tokens and a mock DEX.** This is a testnet prototype, and the DEX fills at exactly the signed price.
- **A demo threshold.** The deployed ETH profile allows a rise of 0.5 % so that a trade can complete during a live run.
  The spec's value is 3 %, and the vault enforces whichever the profile sets.

## What data we wanted but could not find

Everything the product needed had a listing: posts from TwitterAPI.io, crypto prices from Nodary, and oil and stock
prices from TickerLayer. So nothing stopped us from building it, and we have no missing listing to report.

Building it showed two things we would look for next. We don't claim they are absent from AirnodeHub, only that we
worked without them:

| What would help | Why | What we did instead |
| --- | --- | --- |
| **A signed price at a given moment** | P0 should be the price when the post went out | The agent fetches the latest price after it sees the post, and the vault accepts P0 up to ten minutes after the post |
| **A signed "new posts since" feed** | The agent has to poll each account, and every poll costs 0.01 aUSD, whether or not there is a new post | Fixed-interval polling with a small watch list |

Several listings exist that we chose not to use yet, so these are not gaps in AirnodeHub:

| Listing | What it would add | Why it waited |
| --- | --- | --- |
| **OpenRouter** (signed model answers) | Anyone could submit the classification, so no part of a decision would rely on trusting our agent | We decided to skip it for the hackathon. It is next on our roadmap |
| **TickerLayer `marketStatus`, Finnhub market calendars** | The vault could refuse a closed market by name | It reads the source's own timestamp instead and refuses a price older than five minutes. A saved TickerLayer WTI response was already 24 minutes old when signed, early on a Saturday |
| **Twelve Data** (technical indicators, prices) | A signed moving average instead of two raw prices, and a second price source to compare with TickerLayer | A stretch goal and a roadmap item |
