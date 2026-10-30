// The sell keeper: selling uses only signed market prices, never posts. Anyone may submit the signed price; the vault
// checks the condition again before it sells.
import { formatUnits } from 'viem';
import type { SignedResponse } from '../airnode/attestation.ts';
import { formatFixedPoint } from '../airnode/projected-json.ts';
import type { Position, RuleAsset, SellKind, VaultPort } from '../chain/vault.ts';
import { VaultRejection } from '../chain/vault.ts';
import type { EventLog } from '../log.ts';
import { getAsset, isPriceFresh, type Profiles, readSignedPrice } from '../profiles.ts';
import { risesAtLeast } from './gates.ts';

const BPS = 10_000n;

type SellParams = Pick<RuleAsset, 'takeProfitBps' | 'stopLossBps' | 'stagnationBandBps' | 'stagnationAfterSec'>;

// Stop loss first, so a crash is never mistaken for stagnation; then take profit; then the stagnation exit.
export const decideSell = (position: Position, params: SellParams, price: bigint, now: number): SellKind | undefined => {
  const entry = position.entryPrice;
  if (params.stopLossBps > 0 && price * BPS <= entry * (BPS - BigInt(params.stopLossBps))) return 'stop-loss';
  if (risesAtLeast(entry, price, params.takeProfitBps)) return 'take-profit';
  const distance = price > entry ? price - entry : entry - price;
  if (now - position.entryTime >= params.stagnationAfterSec && distance * BPS <= entry * BigInt(params.stagnationBandBps)) {
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
        const kind = decideSell(position, params, price.price, now());
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
