# Fixtures

## Pyth price updates (`pyth/`)

Real, signed Pyth updates, saved in the shape Hermes serves them (`binary.data` is what the vault takes, `parsed` is
read from those bytes). Hermes needs an API key since 26 August 2026, so `npm run pyth-fixtures` in `agent/` takes them
from Base Sepolia instead: each one is the exact accumulator update that someone else's transaction sent to the chain's
Pyth contract, which verified it there. `source` names the transaction.

| File | ETH/USD | Published | Use |
| --- | --- | --- | --- |
| `eth-p0.json` | 2236.50466218 | 1794057378 | P0: Pyth's previous price came a second earlier |
| `eth-p1.json` | 2244.64595033 | 1794059218 | P1, 30 min 40 s later: +0.36% |
| `eth-later.json` | 2242.62750143 | 1794063774 | A price 0.09% under the buy: a stop-loss at 5 bps sells |

Each update also carries BTC/USD and one more feed, so it is a wrong-asset update for any other asset.
`contracts/test/fork/PythFork.t.sol` runs a real buy, a real stop-loss and the tamper test with them against the live
Pyth contract on a fork of Base Sepolia.

## Synthetic cases

The vault's unit and flow tests build their posts and prices in Solidity (`contracts/test/utils/SyntheticFixtures.sol`,
with the times and prices of the hackathon's signed fixtures) on `LocalPyth`, which takes unsigned updates. The agent's
replay and tests script their price paths the same way (`ScriptedPriceSource`).
