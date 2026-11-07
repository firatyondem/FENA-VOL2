// Books every paid action of the agent to the users it served: post fetches, model calls, Pyth's update fees and gas.
// The engine calls it; the ledger stores it; GET /api/costs reads it.
import type { ModelUsage } from '../classifier/types.ts';
import type { TransactionCost } from '../chain/vault.ts';
import type { FetchCost } from '../sources/posts.ts';
import type { EventLog } from '../log.ts';
import type { CostEntry, CostLedger } from '../store/ledger.ts';

export interface CostRecorder {
  postFetch(source: string, users: readonly string[], cost: FetchCost, ref?: string): void;
  aiCall(usage: ModelUsage, users: readonly string[], ref?: string): void;
  transaction(cost: TransactionCost | void, users: readonly string[], ref?: string): void;
}

// What gas would cost in USD: testnet ETH is free, so the agent prices it at mainnet ETH to show what a real run costs
export interface LedgerRecorderOptions {
  ledger: CostLedger;
  // USD per ETH; without it gas and fees count 0 USD but their wei is kept
  ethUsd?: () => number | undefined;
  // The chain's name for the ledger's source column
  chain?: string;
  // Each cost also goes to the log as a cost event, for the cycle summary and the console
  log?: EventLog;
}

export const ledgerRecorder = ({ ledger, ethUsd = () => undefined, chain = 'base-sepolia', log }: LedgerRecorderOptions): CostRecorder => {
  const usdOf = (wei: bigint) => {
    const price = ethUsd();
    return price === undefined ? 0 : (Number(wei) / 1e18) * price;
  };
  const book = (entry: CostEntry) => {
    ledger.record(entry);
    log?.append({
      kind: 'cost',
      costKind: entry.kind,
      source: entry.source,
      usd: entry.usd,
      units: entry.units,
      users: [...entry.users],
      ...(entry.ref ? { ref: entry.ref } : {}),
    });
  };
  return {
    postFetch: (source, users, cost, ref) =>
      book({ kind: 'post-fetch', source, users, units: cost.calls, usd: cost.usd, ...(ref ? { ref } : {}) }),
    aiCall: (usage, users, ref) =>
      book({
        kind: 'ai-call',
        source: usage.model,
        users,
        units: usage.inputTokens + usage.outputTokens,
        usd: usage.usd,
        ...(ref ? { ref } : {}),
      }),
    transaction: (cost, users, ref) => {
      if (!cost) return;
      const tx = cost.txHash ?? ref;
      if (cost.feeWei !== undefined) {
        book({
          kind: 'price-update-fee',
          source: 'pyth',
          users,
          units: 1,
          usd: usdOf(cost.feeWei),
          wei: cost.feeWei,
          ...(tx ? { ref: tx } : {}),
        });
      }
      if (cost.gasWei !== undefined) {
        book({ kind: 'gas', source: chain, users, units: 1, usd: usdOf(cost.gasWei), wei: cost.gasWei, ...(tx ? { ref: tx } : {}) });
      }
    },
  };
};

export const noCosts: CostRecorder = { postFetch: () => {}, aiCall: () => {}, transaction: () => {} };
