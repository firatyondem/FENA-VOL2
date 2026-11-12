# Fixtures for the agent's HTTP API

Example answers of the agent's API, in the shapes from `docs/specs/00-overview.md`. The website builds against these
until Person A's agent is hosted. Each file is what one endpoint returns.

| File | Endpoint |
| --- | --- |
| `health.json` | `GET /api/health` |
| `costs.json` | `GET /api/costs?user=0x..&days=7` |
| `decisions.json` | `GET /api/decisions?user=0x..&limit=50` |
| `faucet.json` | `POST /api/demo/faucet` with body `{ "address": "0x.." }` |

The values are made up. The user is anvil's public test account 0, the transaction hashes do not exist, and the posts
were written for this file.

## What the files cover

- `costs.json`: seven UTC days, oldest first. One day has trades (post fetches, AI calls, Pyth fees and gas), one day
  has no cost at all, and the last day is a part of a day. Each day's `totalUsd` is the sum of its `bySource` entries,
  and the top `totalUsd` is the sum of the days.
- `decisions.json`: newest first, one post per case: skipped by the filter, bought, expired, refused at Gate 2
  (`SpikeTooHigh`, `TrendTooWeak`), refused at Gate 1 (`PriceTooOld`) and not relevant. Each `tweetId` holds the time
  in `createdAt`, as a real X id does.
- `faucet.json`: `eth` is in wei and `usdc` has 6 decimals, both as strings.

## Where they differ from the overview

Checked against the agent on `feat/person-a-v2`:

- The agent also sends `classifier` with each decision, `bySource` with each cost day, and `mode` with the health
  report.
- `verdict` can also be `pending`, for a post the classifier has not answered yet.
- `assetId` is the asset's key, such as `ETH`, not the vault's `bytes32` id.
- The vault's error for a rise below the threshold is `TrendTooWeak`. The overview calls it `BelowThreshold`.
- `lastPollAt` is in milliseconds, and `createdAt` is in seconds.
