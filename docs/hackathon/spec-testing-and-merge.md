# Spec: Heavy testing and merge-conflict resolution

Owner: Person A runs this. Written 2026-10-30.

## Goal

Bring Person B's branch into main without losing anything from either side, then prove the combined system with unit, fuzz, invariant, behaviour (mock) and integration tests. Nothing is pushed until every suite is green and the final conflict check is clean.

## Ground rules

1. Read `docs/spec-person-a.md` first. Its ownership table still applies.
2. Never change production code just to make a test pass. If a test reveals a bug: stop, show the failing test output and the proposed fix as a before/after snippet, and wait for my OK.
3. Never change `IVault` or `IMockDEX` signatures in this task. If a test shows an interface problem, report it.
4. No force push, no rebase of shared branches, no `git checkout --ours/--theirs` on a whole file without reading both sides first.
5. Every revert test uses `vm.expectRevert` with the exact custom error selector, never a bare `expectRevert()`.
6. All code, comments, test names and commit messages in English.
7. One commit per phase. Push only in Phase 6.

## Phase 1 — Find conflicts before touching anything

1. `git fetch --all --prune`. The working tree must be clean; if not, stop and tell me.
2. Find Person B's branch: `git branch -r --no-merged origin/main`. If there is more than one candidate, ask which.
3. Dry run without touching the working tree: `git merge-tree --write-tree --name-only origin/main origin/<b-branch>`. Fallback if git is older than 2.38: `git merge --no-commit --no-ff origin/<b-branch>` then `git merge --abort`.
4. Print a table: file, conflict type (content, add/add, submodule, delete/modify), owner per the ownership table. Do not resolve anything yet; wait for my OK.

## Phase 2 — Resolve conflicts precisely

Create branch `integrate/b-into-main` from `origin/main`, then `git merge --no-ff --no-commit origin/<b-branch>`. Resolve file by file, hunk by hunk:

| File or area | Rule |
| --- | --- |
| `.gitmodules` | Union of both sides, one entry per path. Same path with a different URL: stop and ask. |
| `contracts/lib/*` submodule pointers | Keep main's pinned commit. If B needs a different version of the same library: stop and ask. New libraries from B are kept. |
| `contracts/foundry.lock` | Never hand-merge. Take main's version, then re-run `forge install` for B's added libraries so the lock matches `.gitmodules`. |
| `contracts/foundry.toml` | Main wins (kickoff file). Add a B-side entry only if B's scripts need it (fs_permissions, remappings) and explain each one. |
| `contracts/src/interfaces/*` | Main wins. B's code is updated to the frozen interfaces, never the reverse. |
| `contracts/src/vault/*`, `contracts/src/lib/*`, `contracts/test/*` (A's paths) | Main wins. If B edited any of these, list each hunk and ask before dropping it. |
| `contracts/src/mocks/*`, `contracts/script/*`, `agent/*`, `shared/*` (B's paths) | B wins. Then update every caller to the current interfaces: `setRule(rule, assetIds, assetRules, assetTopics, watchedAccounts)` with 5 arguments, and the `RuleSet` event including `assetTopics`. |
| Any lockfile (`package-lock.json`, `pnpm-lock.yaml`) | Never hand-merge. Keep B's `package.json`, delete the conflicted lockfile, regenerate it with the agent's package manager. |
| `docs/*` | Keep both sides. |
| Line endings only | If a hunk differs only in CRLF/LF, abort and redo the merge with `-X ignore-space-at-eol`. |

After resolving:

1. `git diff --check` and a repo-wide grep for `<<<<<<<`, `=======` and `>>>>>>>` must return nothing.
2. `git submodule update --init --recursive`.
3. `cd contracts && forge build --sizes`: Vault stays under 24,576 bytes.
4. `forge test`: every existing test passes, and the fixture suite now RUNS instead of skipping. If B's fixture files have different names than `ETH_USD_FIXTURE` / `BTC_USD_FIXTURE` expect, report it; do not rename B's files.
5. Agent: install dependencies, typecheck, run its existing tests.
6. Commit the merge. The message lists every conflicted file and the rule applied.

## Phase 3 — Heavy contract tests (`contracts/test/`)

Use the real MockDEX and mock tokens from `contracts/src/mocks/`, not `MockDEXStub`. Use real fixtures wherever a real Airnode signature matters; elsewhere sign with a test Airnode key via `vm.sign`.

### 3.1 Unit: exact boundaries (`contracts/test/unit/`)

Each edge as a pass test plus a fail test:

- Trend: P1 = P0 × (1 + threshold) passes; one unit below reverts.
- Spike cap: P1 = P0 × (1 + cap) passes; one unit above reverts.
- Window: t1 − t0 = minWait passes, minWait − 1 s reverts; = maxWindow passes, maxWindow + 1 s reverts.
- Response age: exactly 5 min passes, 5 min + 1 s reverts.
- Tweet to P0: exactly 10 min passes, 10 min + 1 s reverts; P0 before the tweet reverts.
- Market hours: a source timestamp older than the allowed age reverts.
- Max per trade, daily limit and budget share: exactly at the limit passes, one unit above reverts; the daily limit resets after 24 h.
- Cooldown: exactly the cooldown passes, 1 s less reverts.
- Asset profile: stricter passes and looser reverts, for every field; zero minWait or zero threshold is rejected.
- Take profit and stagnation exit (Z time, ±Y %): both edges.
- Decimals: 6-decimal mock USDC against an 18-decimal asset. Buying and selling at the same price never creates value; the loss is at most 1 unit of rounding.
- Prices of 0, 1 and 1e30: no overflow, clean custom-error revert where invalid.

### 3.2 Fuzz (`contracts/test/fuzz/`)

Fuzz prices, timestamps, amounts and budget shares over bounded ranges and assert that the 3.1 rules hold everywhere. Use inline config, not foundry.toml: `/// forge-config: default.fuzz.runs = 1000`.

### 3.3 Invariants (`contracts/test/invariant/`)

A handler calls deposit, withdraw, setRule, pause, openTrigger, confirmTrigger, expireTrigger and every sell path, as several users and their agent wallets, with random `vm.warp`. Inline config: `/// forge-config: default.invariant.runs = 256` and `/// forge-config: default.invariant.depth = 100`. Invariants:

- The vault's mock-USDC balance equals the sum of all users' free balances.
- The vault's balance of each asset token equals the sum of open positions in that token.
- A position sells at most once; a closed position never reopens.
- A trigger settles at most once; an expired trigger never buys.
- Per user, per asset, per day: spent ≤ that asset's budget share; total spent ≤ the daily limit.
- Only the user's own agent wallet ever opened a trigger.
- No buy happened while the user was paused.
- No signed response was accepted twice for the same user.

### 3.4 Behaviour with mocks (`contracts/test/behaviour/`)

Hostile or broken dependencies, each as a small mock in `contracts/test/behaviour/mocks/`:

- A DEX that reverts: the trigger stays open, no funds move, a later retry works.
- A DEX that delivers less than the promised output: the vault reverts. If the vault does not check this, report it as a finding; do not change the interface.
- A DEX or token that re-enters the vault during a buy or sell (withdraw, sell, confirmTrigger): reverts or has no effect; balances unchanged.
- A token that returns false instead of reverting: no silent loss.
- Signed responses: the four tamper tests (edited value, stale, different request, wrong signer) plus replay of the same response by the same user, using the real fixtures.
- A compromised agent wallet opens triggers for a disallowed asset, an unwatched account, or a repeated tweet: all revert. The agent can never withdraw, or sell to itself.
- The admin changes an asset's token after a buy: the position still sells the token it bought.

### 3.5 Integration (`contracts/test/integration/`)

Full flows with the real MockDEX:

1. deposit → setRule (several assets, budget split, topics) → openTrigger (real signed tweet + P0) → warp minWait → confirmTrigger (P1) → buy at exactly P1 → take profit → position closed; all balances reconcile.
2. The same flow ending in a stagnation exit, and again in a manual sell.
3. Expire: after the window anyone calls expireTrigger; nothing moves.
4. Two users, same tweet, same signed price: both can trigger; each replay guard is per user.
5. One post matching several assets: assets are served in the user's priority order until the daily budget runs out.
6. Pause mid-flow: open a trigger, pause, confirm reverts, withdraw works, unpause, a new trigger works.
7. Deploy script dry run: run B's deploy script without `--broadcast`, assert the profiles from `shared/asset-profiles.json` are set. If it writes to `shared/deployments/`, restore that file afterwards.

## Phase 4 — Agent behaviour tests (`agent/test/`, Person B's folder)

Use the test runner already in `agent/package.json`; do not add a new framework. Mock every external dependency: the TwitterAPI.io Airnode, the LLM API, the Airnode price fetch and the chain RPC.

- Poller: a new tweet is handled once; the same tweet twice is still handled once; reposts are ignored; the pinned-tweet flag reads item #1.
- Relevance: the LLM says relevant for an allowed asset → trigger; an asset outside the user's allowlist → nothing; an asset not linked to that account → nothing; malformed or non-JSON LLM output → nothing, logged, no crash; LLM timeout → one retry, then skip.
- Topics: read from the latest `RuleSet` event with the 5-argument signature; older `RuleSet` events are ignored. This is the regression test for the `assetTopics` change.
- Trigger flow: fetches P0 right after the tweet, opens the trigger, waits minWait, fetches P1, confirms. If confirm reverts with a Gate 2 custom error, it retries until maxWindow, then calls expireTrigger.
- Keeper: sells on take profit, sells on stagnation after Z, never sells otherwise, never sells a position twice.
- Failures: RPC down or Airnode 402/500 → backoff, no duplicate transactions.
- Secrets: no private key or API secret ever appears in logs.

## Phase 5 — Local end-to-end on anvil (only if time allows)

Start anvil, deploy with a test Airnode signer address, run the agent against anvil with a fake X feed and a fake LLM, signing price responses with the test key. Show one full buy and one rejected tamper.

## Phase 6 — Final conflict check and push

1. `git fetch`. If `origin/main` moved (for example B's frontend), repeat the Phase 1 dry run against the new main and resolve with the Phase 2 rules.
2. Run everything: `forge build --sizes`, `forge test`, agent tests.
3. Push `integrate/b-into-main` and open a PR, or merge it into main with `--no-ff` if I say so.
4. Final report:
   - Table of conflicted files with the resolution applied.
   - Test counts per suite: unit, fuzz, invariant, behaviour, integration, agent.
   - Every finding with the failing test's name and the proposed fix.
   - Vault size in bytes.
