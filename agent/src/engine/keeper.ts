// The sell keeper: selling uses only signed market prices, never posts. Anyone may submit the signed price for a take
// profit or a stagnation exit; the vault checks the condition again before it sells.
import { formatUnits } from 'viem';
import type { SignedResponse } from '../airnode/attestation.ts';
import { formatFixedPoint } from '../airnode/projected-json.ts';
import type { Position, RuleAsset, SellKind, VaultPort } from '../chain/vault.ts';
import { VaultRejection } from '../chain/vault.ts';
import type { EventLog } from '../log.ts';
import { getAsset, isPriceFresh, type Profiles, readSignedPrice } from '../profiles.ts';

const BPS = 10_000n;

// The vault's take-profit target, entry * (1 + take profit) rounded up (Vault._checkTakeProfit uses Math.ceilDiv)
export const takeProfitTarget = (entry: bigint, takeProfitBps: number) => {
  const scaled = entry * (BPS + BigInt(takeProfitBps));
  return (scaled + BPS - 1n) / BPS;
};

type SellParams = Pick<RuleAsset, 'takeProfitBps' | 'stagnationBandBps' | 'stagnationAfterSec' | 'stopLossBps'>;

// The vault's sell checks, for a price the source took at `priceTime`. Stop loss first, so a crash is never read as
// stagnation; then take profit; then the stagnation exit. A 0 turns each one off, as in the vault.
export const decideSell = (
  position: Position,
  params: SellParams,
  price: bigint,
  priceTime: number,
  allowed: readonly SellKind[] = ['take-profit', 'stagnation', 'stop-loss']
): SellKind | undefined => {
  if (priceTime < position.entryTime) return undefined;
  const entry = position.entryPrice;
  const stop = params.stopLossBps ?? 0;
  if (allowed.includes('stop-loss') && stop > 0 && price * BPS <= entry * (BPS - BigInt(stop))) return 'stop-loss';
  if (
    allowed.includes('take-profit') &&
    params.takeProfitBps > 0 &&
    price >= takeProfitTarget(entry, params.takeProfitBps)
  ) {
    return 'take-profit';
  }
  const distance = price > entry ? price - entry : entry - price;
  if (
    allowed.includes('stagnation') &&
    params.stagnationAfterSec > 0 &&
    priceTime >= position.entryTime + params.stagnationAfterSec &&
    distance * BPS <= entry * BigInt(params.stagnationBandBps)
  ) {
    return 'stagnation';
  }
  return undefined;
};

export interface SellKeeperDeps {
  profiles: Profiles;
  vault: VaultPort;
  fetchPrice: (asset: string) => Promise<SignedResponse>;
  log: EventLog;
  now: () => number;
}

export class SellKeeper {
  private readonly deps: SellKeeperDeps;

  constructor(deps: SellKeeperDeps) {
    this.deps = deps;
  }

  async tick(): Promise<void> {
    const { vault, profiles, log, now } = this.deps;
    const open = (await vault.listPositions()).filter((position) => position.open);
    if (open.length === 0) return;
    const rules = new Map((await vault.listRules()).map((rule) => [rule.id, rule]));
    const prices = new Map<string, Promise<SignedResponse>>();

    for (const position of open) {
      const params = rules.get(position.ruleId)?.assets.find((entry) => entry.asset === position.asset);
      if (!params) continue;
      try {
        if (!prices.has(position.asset)) prices.set(position.asset, this.deps.fetchPrice(position.asset));
        const response = await (prices.get(position.asset) as Promise<SignedResponse>);
        const price = readSignedPrice(profiles, getAsset(profiles, position.asset), response);
        if (!isPriceFresh(profiles, price, now())) continue;
        const kind = decideSell(position, params, price.price, price.sourceTime, vault.keeperSellKinds);
        if (!kind) continue;
        const sold = await vault.sell(position.id, kind, response);
        log.append({
          kind: 'position.sold',
          positionId: position.id,
          asset: position.asset,
          sellKind: kind,
          price: formatFixedPoint(sold.price, 18),
          usdcOut: formatUnits(sold.usdcOut, profiles.usdcDecimals),
        });
      } catch (error) {
        const message = error instanceof VaultRejection ? error.reason : (error as Error).message;
        log.append({ kind: 'error', where: `keeper position ${position.id}`, message });
      }
    }
  }
}
