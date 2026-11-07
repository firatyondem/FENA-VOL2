# Spec: The agent runs on its own (agent wallet, live cycles, limits, failure handling)

Owner: Person A runs this. It touches `agent/` (Person B's folder) and `docs/`; Person B knows and keeps his hands off `agent/` until the branch is merged. Written 2026-10-31.

## Goal

Earn the agent bonus. The judges want to see:

1. **An agent wallet.** The agent has its own wallet with a little test ETH and sends its price checks (`confirmTrigger`), purchases, expiries and sells from it.
2. **An autonomous run.** The agent runs live on Base Sepolia for a while and repeats its cycle on its own, without anyone pressing buttons.
3. **Proof and explanation.** We can show the cycles it ran and explain its **schedule**, its **spending limits** and its **failure handling**, with numbers from the actual run.

### What already exists (do not rebuild it)

Read these first; this spec only fills gaps:

| Piece | Where | What it does today |
| --- | --- | --- |
| Live mode | `agent/src/live.ts` | Polls every watched account every `POLL_INTERVAL_SEC` (60 s); every 5 s runs `engine.checkPending()` then `keeper.tick()`; overlap flags `polling` / `ticking` |
| Gate 1 / Gate 2 | `agent/src/engine/trigger-engine.ts` | Post → classify → `openTrigger`; P1 every 30 s per trigger → `confirmTrigger`; expires closed windows. Pending triggers live **only in memory** |
| Sell keeper | `agent/src/engine/keeper.ts` | Take profit and stagnation exit from signed prices |
| Vault writes | `agent/src/chain/viem-vault.ts` `send()` | Simulates first, then sends; a revert becomes `VaultRejection(name)`; `waitForTransactionReceipt` has **no timeout** |
| Paid data | `agent/src/airnode/client.ts` | x402 payment in aUSD, max $1 per payment, aUSD only; tweets 0.01 aUSD, TickerLayer 0.05 aUSD; per `agent/README.md` only tweets and TickerLayer prices are paid, so Nodary prices (ETH, BTC, DOGE) cost nothing |
| Explanation log | `agent/src/log.ts` | Typed events, kept in memory (capacity 500) and appended to `agent/.data/events.jsonl` |
| Wire Desk | `agent/src/console/` | Read-only console on :4173; `/api/state`, `/api/stream`, `/api/signed-price` |

### Gaps this spec closes

1. No explicit **cycle**: two independent timers, nothing that says "cycle 57 ran at 14:03, did X, spent Y".
2. No **agent-side budget**: the vault limits the user's money, but nothing limits what the agent spends of its **own** aUSD (data) and ETH (gas). It even pays to poll accounts that no active rule watches.
3. **Unattended-run hazards:** a dropped transaction hangs `waitForTransactionReceipt` forever, and `ticking` then stays true, so every later Gate 2 check and sell is silently skipped. A restart loses all open triggers. An unhandled rejection in `poll` crashes the process with nobody to restart it. Every tick re-reads all events from `deployedAtBlock` over the public RPC.
4. Nothing to **show**: no cycle view, no budget or wallet view, no run report.

## Ground rules

1. **No change to `contracts/`** and none to `frontend/` except the agent address in `frontend/js/config.js` (Phase 1).
2. **Keys:** Claude Code never asks for, prints, logs or commits a private key. Keys are entered by me in the terminal (Phase 1). Scripts derive and print **addresses only**.
3. **Branch** `feat/agent-autonomy`. Start from `main` if `feat/frontend-live` is merged; if it is not, ask me, and on my OK branch from `origin/feat/frontend-live`.
4. One commit per phase; push the branch after each green phase; merge to `main` only on my OK.
5. English only in code, comments, tests and commits. Match the agent's existing style: small modules, dependency injection, `node:test`, no new runtime dependencies.
6. **Stop on red.** Every phase ends with `cd agent && npm test && npm run typecheck`; contracts untouched means `forge test` stays at 375/375. If anything fails, stop and report.
7. Every new behaviour gets a unit test with fakes (fake clock, fake vault, fake fetch). Live behaviour is proven in Phase 6.

### Priorities, if time runs out

| Priority | Phases | Without it |
| --- | --- | --- |
| **Must** | 1, 2, 3, 4a–4c, 6 | No bonus |
| **Should** | 4d–4f, 5a, 5b | The run works but is harder to show or riskier |
| **Nice** | 5c, 7 | Explain verbally instead |

## Phase 0: Preconditions

1. Branch as in ground rule 3. `cd agent && npm install && npm test && npm run typecheck` all green before any change.
2. Confirm the Base Sepolia deployment exists: `shared/deployments/84532.json` with a non-zero `deployedAtBlock`. If not, stop: the deploy (previous spec, Phase 7) comes first.
3. Confirm `agent/config/watchlist.json` contains our demo X account with assets limited to ETH, BTC and DOGE (it is Saturday: oil and Tesla are closed and their prices go stale). If missing, stop and tell me; it must be there **before** the deploy so the vault registers the account.

## Phase 1: Agent wallet (I do this; Claude Code only verifies)

I create a new MetaMask account (or import the `AGENT` key generated earlier), fund it with ~0.02 Base Sepolia ETH, and put its key into `agent/.env` with a hidden prompt. Claude Code does **not** handle the key.

Claude Code builds `npm run wallets` (`agent/scripts/wallets.ts`):

- Reads `AGENT_PRIVATE_KEY` and `PAYER_PRIVATE_KEY` from `agent/.env` and derives the addresses. Never prints a key.
- Prints for each: role, address, basescan link (`https://sepolia.basescan.org/address/<addr>`), balance (agent: ETH; payer: aUSD at `AUSD_ADDRESS` from `client.ts`, 6 decimals; payer ETH should be 0 and is not needed).
- Checks: agent ETH ≥ `AGENT_MIN_ETH` (Phase 3); payer aUSD ≥ `PAYER_MIN_AUSD`; agent ≠ payer (different wallets on purpose: a stolen agent key cannot spend data money and the other way round).
- Reads every rule from the vault (`ViemVault.listRules()`) and reports how many users name this agent wallet. If zero: "No user has approved this agent yet: save a rule in the frontend naming <agent address>".
- Estimated runtime left: aUSD balance ÷ (paid calls per hour at the current watchlist and poll interval × 0.01).

Also: set `NETWORKS[84532].agent` in `frontend/js/config.js` to the agent's **address** (public), in its own commit. The demo user must (re-)save their rule so `rule.agent` is this address.

**Checks 1:** `npm run wallets` shows both addresses, ETH > 0 on the agent, aUSD > 0 on the payer, and at least one rule naming the agent. Unit test for the pure parts (runtime estimate, checks) with fake balances.

Commits: `feat(agent): wallet status script`; `chore(frontend): Base Sepolia agent address`.

## Phase 2: One explicit cycle

New module `agent/src/engine/cycle.ts` with a `CycleRunner` class. `live.ts` uses it instead of its two `setInterval`s. Replay mode is unchanged.

### Schedule

| Setting (env, default) | Meaning |
| --- | --- |
| `CYCLE_INTERVAL_SEC=30` | One cycle starts every 30 s |
| `POLL_INTERVAL_SEC=60` | Paid post polling runs in a cycle only if at least this long passed since the last poll |
| `P1_INTERVAL_SEC=30` | Passed to the engine's existing `p1IntervalSec` |

### Steps of one cycle, always in this order

1. **Health and budget** (Phase 3): read the agent's ETH and the payer's aUSD balance; set the mode `normal`, `saving` or `halted`.
2. **Rules:** `vault.listRules()`. Compute the **active watch set**: accounts that at least one unpaused rule naming this agent watches.
3. **Gate 2 first:** `engine.checkPending()`. Open triggers are time-critical and already paid for, so they go before new work.
4. **Keeper:** `keeper.tick()`.
5. **Gate 1:** if the poll is due and the mode allows it, `engine.pollAccount()` **only for the active watch set**. No rule, no paid call.
6. **Summary:** append one `cycle.finished` event.

### Rules

- **No overlap:** if a cycle is still running when the next is due, skip that start and append `cycle.skipped { cycle, reason: "previous cycle still running", runningForMs }`. Never run two at once.
- Each step runs in its own try/catch. A failing step logs `error` with `where: "cycle <n> step <name>"` and the cycle continues with the next step. A cycle never throws.
- Count what happened by subscribing to the `EventLog` for the duration of the cycle (no changes to the engine needed).

### New log events (extend the `AgentEvent` union in `log.ts`)

```ts
| { kind: 'cycle.finished'; cycle: number; startedAt: number; durationMs: number; mode: 'normal' | 'saving' | 'halted';
    polled: boolean; accountsPolled: string[]; postsNew: number; classified: number; triggersOpened: number;
    p1Checks: number; bought: number; rejected: number; expired: number; sold: number; paidCalls: number;
    txSent: number; ausdSpent: string; ethSpent: string; errors: number; nextAt: number }
| { kind: 'cycle.skipped'; cycle: number; reason: string; runningForMs: number }
```

`ausdSpent` and `ethSpent` come from the balance difference between the start and the end of the cycle (Phase 3 reads both anyway). A payment can settle a block late; the daily totals in Phase 3 are authoritative.

Raise the `EventLog` capacity to 5,000 so a multi-hour run fits in memory, but keep `/api/state` returning at most the last 1,000 events so the console and the frontend stay fast.

### Tests (`agent/test/cycle.test.ts`) with a fake clock and fakes

- Step order is health → rules → Gate 2 → keeper → Gate 1 → summary.
- Gate 1 runs only when `POLL_INTERVAL_SEC` has passed, and only for accounts in the active watch set; with no rules there are zero paid calls.
- A paused rule's accounts are not polled.
- Overlap: a slow cycle causes `cycle.skipped`, never two concurrent cycles.
- A throwing step logs an error and the later steps still run; `cycle.finished` is always written.
- The counters in `cycle.finished` match the events appended during the cycle.

Commit: `feat(agent): one explicit cycle with a fixed step order`.

## Phase 3: Agent-side spending limits (the agent's own money)

The vault already protects the **user's** money (Phase 7 explains those limits). This phase protects the **agent's** own resources: aUSD for data and ETH for gas.

### Settings (env, add to `.env.example` with comments)

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT_BUDGET_AUSD_PER_DAY` | `3` | Most aUSD the payer may spend per UTC day |
| `AGENT_BUDGET_ETH_PER_DAY` | `0.005` | Most ETH the agent wallet may spend on gas per UTC day |
| `AGENT_MIN_ETH` | `0.0005` | Below this, the agent sends no transaction |
| `PAYER_MIN_AUSD` | `0.2` | Below this, the agent makes no paid call |
| `AGENT_MAX_TX_PER_HOUR` | `30` | Hard cap on transactions per rolling hour |
| `AGENT_SAVING_AT_PCT` | `80` | Share of a daily budget at which saving mode starts |

### Budget module `agent/src/engine/budget.ts`

- At start and at each UTC day change, record the day-start balances (payer aUSD, agent ETH). Spent today = day-start balance − current balance, never below 0. If a balance goes up (a top-up), raise the day-start figure by the top-up, so a top-up is not counted as negative spend.
- **Modes**, re-evaluated in cycle step 1:
  - `normal`: everything allowed.
  - `saving` (a daily budget ≥ `AGENT_SAVING_AT_PCT`, or a balance within 2× of its minimum): **no new post polls** (so no new triggers), but existing triggers keep getting Gate 2 checks, expiries and sells. Reason: finish what the users' money is already committed to, start nothing new.
  - `halted` (a daily budget used up, or a balance below its minimum): no paid calls and no transactions, except `expireTrigger` while ETH ≥ `AGENT_MIN_ETH` (it needs no price). The cycle keeps running and keeps writing `cycle.finished`, so the heartbeat stays visible.
- Append `{ kind: 'budget.mode'; mode; reason; ausdSpentToday; ethSpentToday; ausdBalance; ethBalance }` only when the mode changes, plus once at start.

### Enforcement points (wrap, do not scatter checks through the engine)

- **Paid fetch:** wrap the agent's `airnodeFetch` so a call to a priced Airnode is refused (throws a typed `BudgetRefusal`) when the mode forbids paid calls. The engine already treats a failed fetch as "try again later", which is the right behaviour here.
- **Transactions:** a `GuardedVault` decorator around `ViemVault` (implements `VaultPort`) refuses `openTrigger`, `confirmTrigger` and `sell` in `halted` mode, and any write over `AGENT_MAX_TX_PER_HOUR`, with `BudgetRefusal`. Reads pass through.
- Existing caps stay: x402 at most $1 per payment, aUSD only.

### Tests (`agent/test/budget.test.ts`)

Day-start capture and UTC day reset; spend computation including a top-up; each mode transition and its reason; saving blocks polls but allows Gate 2 and sells; halted allows only `expireTrigger`; the tx-per-hour cap; `budget.mode` appended only on change.

Commit: `feat(agent): daily aUSD and gas budgets with saving and halted modes`.

## Phase 4: Failure handling for an unattended run

### 4a. Transaction timeout (Must)

`ViemVault.send()`: `waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS })`, default 90,000. On timeout, throw a non-revert error (`TxTimeout`, with the hash) so the caller retries on a later cycle, and log `error` with the hash. Also return the gas cost (`receipt.gasUsed * receipt.effectiveGasPrice`) and add an optional `gasEth` field to the `trigger.opened`, `trigger.bought`, `trigger.expired` and `position.sold` events. Test with a fake public client that never resolves.

### 4b. Recover open triggers after a restart (Must)

On start, before the first cycle: read `TriggerOpened` events since `deployedAtBlock` for users whose rule names this agent, keep those whose `getTrigger(id).status` is `Open`, and put them back into the engine's pending set with P0 and t0 from the event and the asset's parameters from the user's rule. Gate 2 only needs P0's price and time, so narrow `PendingTrigger.p0` to `{ price, sourceTime }` (or an equivalent) instead of faking a signed response. Triggers whose window already closed are expired in the first cycle. Append `{ kind: 'agent.recovered'; openTriggers: string[] }`. Add an engine method for this (`restorePending(...)`). Test: open → "restart" (new engine) → recovered → confirmed or expired.

### 4c. Supervisor and crash safety (Must)

- `live.ts`: catch everything in the timers' callbacks; add `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers that append an `error` event, flush, and exit with code 1.
- New `agent/scripts/supervise.ts` and npm script `live:supervised`: starts `node --env-file-if-exists=.env src/main.ts` with `AGENT_MODE=live` as a child, restarts it when it exits with a non-zero code, with backoff 5 s → 10 s → 20 s → 60 s (reset after 10 minutes of uptime), at most 20 restarts per hour, then gives up loudly. It prints the child's PID at each start (needed for the Phase 6 restart demo) and passes Ctrl+C through as a clean stop (no restart). Works on Windows (Git Bash) and Linux; no pm2, no new dependency.
- The child appends `{ kind: 'agent.started' ... }` as today; add a `restarts` count from an env var the supervisor sets.

### 4d. Back off a failing source (Should)

Per source (`twitterapi`, `nodary`, `tickerlayer`, `rpc`, `classifier`): count consecutive failures; after 3, skip that source for 2, 4, 8 … cycles, up to 10 minutes. Append `{ kind: 'source.degraded'; source; failures; retryAt }` and `{ kind: 'source.recovered'; source }`. This keeps a down Airnode from being hammered (and paid) every cycle.

### 4e. Cheaper chain reads (Should)

`ViemVault.listRules()` and `listPositions()` read all events from `deployedAtBlock` on every call. Cache the logs and fetch only from the last fetched block + 1 on each call; chunk ranges at 2,000 blocks and halve on a "range too large" error. Behaviour stays identical; extend `viem-vault.test.ts`.

### 4f. RPC choice (Should, config only)

Document in `.env.example` that a long run should use a provider RPC (for example a free Alchemy or QuickNode Base Sepolia URL) in `RPC_URL`, because the public `https://sepolia.base.org` rate-limits.

Commits: one per sub-phase, e.g. `fix(agent): time out stuck transactions and report gas`, `feat(agent): recover open triggers after a restart`, `feat(agent): supervisor and crash safety`, `feat(agent): back off failing sources`, `perf(agent): incremental event reads`.

## Phase 5: Show the cycles

### 5a. Status in the Wire Desk (Should)

- `startConsoleServer` gets an optional `status()` callback; `/api/state` includes its result as `status`. The `CycleRunner` and budget provide it: uptime, restarts, cycles run, last cycle time and its age, mode, budgets used today vs limit (aUSD, ETH), balances, both wallet addresses with basescan links, active watch set, poll interval, cycle interval, next cycle time.
- Console UI (`agent/src/console/public/`): a new "The Engine Room" section above the three columns:
  - a heartbeat: "Last cycle 12 s ago", red if older than 3 × `CYCLE_INTERVAL_SEC`;
  - wallet cards: agent (ETH, link) and payer (aUSD, link);
  - budget bars with the mode badge;
  - a cycle strip: the last 60 cycles as small squares (grey = quiet, blue = polled, green = bought or sold, amber = rejection, red = error or skipped), hover for the `cycle.finished` details;
  - totals since start: cycles, posts, triggers, buys, sells, aUSD, ETH, errors recovered, restarts.
- Keep the console read-only and keep its existing CSP; the view logic goes into `view-model.js` so `console.test.ts` can test it.

### 5b. Run report (Should)

`npm run run-report -- [--since 2h]` (`agent/scripts/run-report.ts`): reads `agent/.data/events.jsonl` and writes `agent/.data/run-report.md` (gitignored by `agent/.data/`) and prints a summary:

- run window, uptime, restarts, cycles run, skipped cycles;
- per hour: cycles, polls, posts, triggers opened, bought, rejected (by reason), expired, sold, aUSD, ETH, errors;
- every agent transaction with its basescan tx link (`https://sepolia.basescan.org/tx/<hash>`);
- mode changes and source degradations with times;
- the active settings (intervals and limits).

Test with a fixture `events.jsonl` in `agent/test/fixtures/`.

### 5c. Frontend badge (Nice)

The frontend already reads `/api/state`. Show a small "Agent: running · last cycle 12 s ago · normal" badge on the Activity tab in live mode. Only touch `frontend/` here; separate commit.

Commits: `feat(agent): engine room in the Wire Desk`, `feat(agent): run report`, `feat(frontend): agent heartbeat badge`.

## Phase 6: The live run (together)

This is the proof. Claude Code prepares the commands and a checklist; I run them.

### Before

1. `npm run wallets`: agent ETH ≥ 0.01, payer aUSD ≥ 3, at least one rule naming the agent.
2. Cost check: paid tweet calls per hour = active watched accounts × 3,600 / `POLL_INTERVAL_SEC`, × 0.01 aUSD. With 2 accounts at 60 s: 1.2 aUSD/h. Keep the watch set small (demo account + one real account).
3. Demo user's rule: ETH, BTC and/or DOGE only, demo timings, a buy amount that fits the per-trade and daily limits for several buys.
4. Laptop stays awake: plugged in, sleep off for the run (Windows: Settings → System → Power → "When plugged in, put my device to sleep after: Never"; restore afterwards).
5. `agent/.env`: `AGENT_MODE=live`, `CHAIN_ID=84532`, `RPC_URL` (provider RPC if available), the three keys, budgets as above. `git check-ignore agent/.env` prints the path.

### During (at least 90 minutes)

1. `cd agent && npm run live:supervised`. Open the Wire Desk (`http://127.0.0.1:4173`) and the agent's basescan page.
2. Let it run quiet for 10 minutes: cycles tick, spend only on polls, nothing else.
3. Post from the demo X account about one of the assets three times, about 20–30 minutes apart. Each post: `post.seen` → `post.classified` → `trigger.opened` (agent tx) → P1 checks → bought, rejected or expired.
4. **Restart demo:** in a second terminal, kill the child by its PID (`taskkill //PID <pid> //F` in Git Bash, `kill <pid>` on Linux) while a trigger is open. The supervisor restarts it, `agent.recovered` lists the trigger, and the next cycles finish it.
5. Optional **budget demo**, in a separate short run afterwards: start with `AGENT_BUDGET_AUSD_PER_DAY=0.05` and watch the mode go to `saving`, then `halted`, with polls stopping and the heartbeat continuing.
6. Screenshot the Engine Room every 30 minutes.

### After

1. Ctrl+C (clean stop, no restart).
2. `npm run run-report -- --since 3h`; keep `run-report.md` and the screenshots for the pitch.
3. Copy the agent's basescan address link into the pitch notes.

**Expectation, honestly:** with real prices, most triggers will expire or be rejected (`TrendTooWeak`), because a 3 % rise within 10 minutes is rare. That is fine for this bonus: what counts is that the agent runs its cycle on its own, acts on the chain from its own wallet, respects its limits and survives failures. A rejection by the vault is the system working.

## Phase 7: The explanation for the judges (Nice, but cheap)

Write `docs/agent-operations.md` (English), filled with the **actual** values from `.env.example` defaults and from the run report:

1. **Schedule:** the cycle table from Phase 2 and the step order, with why Gate 2 runs before Gate 1.
2. **Two layers of limits:**
   - the user's money, enforced by the vault: buy amount, max per trade, daily limit split by budget shares, cooldown per asset, trend threshold and spike cap, minimum wait and maximum window, pause, take profit and stagnation exit; the agent cannot withdraw or move funds, only bring signed proof;
   - the agent's own money, enforced by the agent: daily aUSD and gas budgets, minimum balances, transactions per hour, $1 per payment, aUSD only, no polling without an active rule, saving and halted modes.
3. **Failure handling table:** failure → what the agent does → where it is visible. Rows: vault revert; Airnode down; RPC down; classifier down or refusing; stuck transaction; crash; restart with open triggers; budget used up; low balance; market closed (stale price); forged or tampered data (the vault refuses it).
4. **Evidence:** numbers from the run report and links to the agent's basescan page and a few transactions.
5. **A 60-second talk track** for the pitch.

Link it from `agent/README.md`.

Commit: `docs: how the agent runs on its own`.

## Final checks

- `cd agent && npm test && npm run typecheck && npm run test:e2e` green; `node --test frontend/test/` green; `cd contracts && forge test` 375/375.
- The replay (`npm start` without keys) still works unchanged.
- `npm run wallets` and `npm run run-report` work.
- No key in any commit: `git log -p feat/agent-autonomy | grep -iE "PRIVATE_KEY=0x[0-9a-f]{64}"` prints nothing.
- Push `feat/agent-autonomy`; merge to `main` only on my OK.

## Estimate

| Phase | Estimate |
| --- | --- |
| 0 | 10 min |
| 1 | 15 min (+ my 10 min for MetaMask and faucet) |
| 2 | 45 min |
| 3 | 45 min |
| 4a–4c | 45–60 min |
| 4d–4f | 30–45 min |
| 5a–5b | 45–60 min |
| 5c | 15 min |
| 6 | 90–120 min wall-clock, mostly waiting |
| 7 | 20 min |

Must path (1, 2, 3, 4a–4c, 6): about 3.5–4.5 hours including the run. Start the live run as early as the Must phases allow. Phases 5 and 7 can be built while it runs, because the report and the console read the run's log afterwards, but build them in a separate worktree (`git worktree add ../api3-agent-ui feat/agent-autonomy`) so a supervisor restart never loads half-written code. Restart the run on the finished code only if there is time for a second run.
