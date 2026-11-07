// The sell keeper: selling uses only Pyth prices, never posts. Anyone may submit a price for take-profit, stop-loss or a
// stagnation exit; the vault checks the condition again, against the exits the position was bought with.
import { formatUnits } from 'viem';
import type { Position, PositionExits, SellKind, VaultPort } from '../chain/vault.ts';
import { transactionFields, VaultRejection } from '../chain/vault.ts';
import type { EventLog } from '../log.ts';
import { getAsset, isPriceFresh, type Profiles, readPythPrice } from '../profiles.ts';
import type { PriceSource } from '../pyth/price-source.ts';
import type { PriceUpdate } from '../pyth/hermes.ts';
import { type CostRecorder, noCosts } from './costs.ts';
import { formatPrice } from './format.ts';

const BPS = 10_000n;

// The vault's take-profit target, entry * (1 + take profit) rounded up (Vault._checkTakeProfit uses Math.ceilDiv)
export const takeProfitTarget = (entry: bigint, takeProfitBps: number) => {
  const scaled = entry * (BPS + BigInt(takeProfitBps));
  return (scaled + BPS - 1n) / BPS;
};

// The vault's sell checks, for a price Pyth published at `priceTime`. Stop loss first, so a crash is never read as
// stagnation; then take profit; then the stagnation exit. A 0 turns each one off, as in the vault.
export const decideSell = (
  position: Pick<Position, 'entryPrice' | 'entryTime'>,
  exits: PositionExits,
  price: bigint,
  priceTime: number,
  allowed: readonly SellKind[] = ['take-profit', 'stagnation', 'stop-loss']
): SellKind | undefined => {
  if (priceTime < position.entryTime) return undefined;
  const entry = position.entryPrice;
  const stop = exits.stopLossBps;
  if (allowed.includes('stop-loss') && stop > 0 && price * BPS <= entry * (BPS - BigInt(stop))) return 'stop-loss';
  if (allowed.includes('take-profit') && exits.takeProfitBps > 0 && price >= takeProfitTarget(entry, exits.takeProfitBps)) {
    return 'take-profit';
  }
  const distance = price > entry ? price - entry : entry - price;
  if (
    allowed.includes('stagnation') &&
    exits.stagnationAfterSec > 0 &&
    priceTime >= position.entryTime + exits.stagnationAfterSec &&
    distance * BPS <= entry * BigInt(exits.stagnationBandBps)
  ) {
    return 'stagnation';
  }
  return undefined;
};

export interface SellKeeperDeps {
  profiles: Profiles;
  vault: VaultPort;
  prices: PriceSource;
  log: EventLog;
  now: () => number;
  costs?: CostRecorder;
}

export class SellKeeper {
  private readonly deps: SellKeeperDeps;

  constructor(deps: SellKeeperDeps) {
    this.deps = deps;
  }

  async tick(): Promise<void> {
    const { vault, profiles, log, now, costs = noCosts } = this.deps;
    const open = (await vault.listPositions()).filter((position) => position.open);
    if (open.length === 0) return;
    const prices = new Map<string, Promise<PriceUpdate>>();

    for (const position of open) {
      try {
        if (!prices.has(position.asset)) prices.set(position.asset, this.deps.prices.latest(position.asset));
        const update = await (prices.get(position.asset) as Promise<PriceUpdate>);
        const price = readPythPrice(getAsset(profiles, position.asset), update);
        if (!isPriceFresh(profiles, price, now())) continue;
        const kind = decideSell(position, position.exits, price.price, price.sourceTime, vault.keeperSellKinds);
        if (!kind) continue;
        const sold = await vault.sell(position.id, kind, update);
        costs.transaction(sold, [position.ruleId], `sell ${position.id}`);
        log.append({
          kind: 'position.sold',
          positionId: position.id,
          asset: position.asset,
          sellKind: kind,
          price: formatPrice(sold.price),
          usdcOut: formatUnits(sold.usdcOut, profiles.usdcDecimals),
          ...transactionFields(sold),
        });
      } catch (error) {
        const message = error instanceof VaultRejection ? error.reason : (error as Error).message;
        log.append({ kind: 'error', where: `keeper position ${position.id}`, message });
      }
    }
  }
}
