# Signed fixtures

Owner: Person B. Read-only for everyone else; regenerate with `cd agent && npm run fixtures`.

## Real responses (root of this folder)

Fetched from the Nodary Airnode v2 (`0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0`) with the projections in
`shared/asset-profiles.json`. Their signatures are genuine.

| File | Use |
| --- | --- |
| `nodary-eth-usd.json` | A real ETH/USD price. Older than 5 minutes by the time you read it: the real "stale response". |
| `nodary-btc-usd.json` | A real price for a second asset: the real "different request" case against the ETH request. |
| `nodary-doge-usd.json` | A real small price (`0.075845`), to test decimal reading. |

## Synthetic responses (`synthetic/`)

The TwitterAPI.io and TickerLayer operations cost aUSD, and real prices rarely move 3% in five minutes, so these are
signed the way an Airnode signs, by a **public test-only key**. In vault tests, expect
`manifest.fixtureAirnode.address` as the Airnode for tweets and prices. The request hashes are the real ones.

`synthetic/manifest.json` lists every request hash, the demo rules the cases are built for, the time anchors, and the
expected outcome of each file:

- Tweets: `tweet-trump-venezuela` (accept), `tweet-musk-doge` (accept, non-ASCII), `tweet-trump-old` (P0 too long after
  the post)
- ETH P0/P1: `eth-p0`, then `eth-p1-rise` (accept), `-flat` (below threshold), `-spike` (above cap), `-early`, `-late`
- Oil P0/P1: `oil-p0`, `oil-p1-rise` (accept)
- The four tamper tests from the spec: `tamper-edited-value`, `tamper-stale`, `tamper-different-request`,
  `tamper-wrong-signer`

Tweet ids are real-format Snowflakes, so `(id >> 22) + 1288834974657` is the post's creation time in milliseconds,
which the vault can compute instead of parsing X's `createdAt` string.

Submit `data` as its exact UTF-8 bytes (`toHex(response.data)`), never re-serialized.
