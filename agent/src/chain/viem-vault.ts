// Talks to the deployed vault. Every write is simulated first, so a revert surfaces with the vault's custom error name
// before any gas is spent, and the console can say which check stopped it.
import {
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hash,
  type Log,
  parseEventLogs,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Account,
} from 'viem';
import { type SignedResponse, toSubmission } from '../airnode/attestation.ts';
import { SELL_KINDS, vaultAbi } from './vault-abi.ts';
import {
  type Bought,
  type OpenedTrigger,
  type OpenTriggerInput,
  type Position,
  type Rule,
  type SellKind,
  type Sold,
  VaultRejection,
  type VaultPort,
} from './vault.ts';

export interface ViemVaultOptions {
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  // Token address per asset key, from shared/deployments/<chain id>.json
  assets: Record<string, Address>;
  rules: Rule[];
}

// The custom error name of a revert, or the message when the error is not a revert.
export const revertReason = (error: unknown): string => {
  if (error instanceof BaseError) {
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? revert.signature ?? 'Reverted';
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
};

export const readEvent = <Name extends 'TriggerOpened' | 'TriggerConfirmed' | 'PositionSold'>(logs: Log[], eventName: Name) => {
  const [event] = parseEventLogs({ abi: vaultAbi, logs, eventName });
  if (!event) throw new Error(`The transaction emitted no ${eventName}`);
  return event;
};

export class ViemVault implements VaultPort {
  readonly kind = 'onchain';
  private readonly options: ViemVaultOptions;
  private readonly positions = new Map<string, Position>();
  private readonly triggers = new Map<string, { ruleId: string; asset: string }>();

  constructor(options: ViemVaultOptions) {
    this.options = options;
  }

  async listRules(): Promise<Rule[]> {
    return this.options.rules;
  }

  // The positions this agent bought; the vault re-checks ownership and state on every sell.
  async listPositions(): Promise<Position[]> {
    return [...this.positions.values()];
  }

  private token(asset: string): Address {
    const address = this.options.assets[asset];
    if (!address) throw new VaultRejection('AssetNotDeployed', asset);
    return address;
  }

  private async send(
    functionName: 'openTrigger' | 'confirmTrigger' | 'expireTrigger' | 'sell',
    args: readonly unknown[]
  ): Promise<{ hash: Hash; logs: Log[] }> {
    const { publicClient, walletClient, address } = this.options;
    try {
      const { request } = await publicClient.simulateContract({
        address,
        abi: vaultAbi,
        functionName,
        args: args as never,
        account: walletClient.account,
      });
      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new VaultRejection('Reverted', hash);
      return { hash, logs: receipt.logs };
    } catch (error) {
      if (error instanceof VaultRejection) throw error;
      throw new VaultRejection(revertReason(error));
    }
  }

  async openTrigger({ ruleId, asset, account, post, p0 }: OpenTriggerInput): Promise<OpenedTrigger> {
    const { hash, logs } = await this.send('openTrigger', [
      BigInt(ruleId),
      this.token(asset),
      account,
      toSubmission(post),
      toSubmission(p0),
    ]);
    const triggerId = readEvent(logs, 'TriggerOpened').args.triggerId.toString();
    this.triggers.set(triggerId, { ruleId, asset });
    return { triggerId, txHash: hash };
  }

  async confirmTrigger(triggerId: string, p1: SignedResponse): Promise<Bought> {
    const { hash, logs } = await this.send('confirmTrigger', [BigInt(triggerId), toSubmission(p1)]);
    const { args } = readEvent(logs, 'TriggerConfirmed');
    const opened = this.triggers.get(triggerId);
    const position: Position = {
      id: args.positionId.toString(),
      ruleId: opened?.ruleId ?? '',
      asset: opened?.asset ?? '',
      amount: args.assetOut,
      entryPrice: args.price,
      // The Airnode's signing time of P1, within seconds of its source time
      entryTime: Number(p1.timestamp),
      open: true,
    };
    this.positions.set(position.id, position);
    return {
      triggerId,
      positionId: position.id,
      usdcIn: args.usdcIn,
      assetOut: args.assetOut,
      price: args.price,
      txHash: hash,
    };
  }

  async expireTrigger(triggerId: string): Promise<void> {
    await this.send('expireTrigger', [BigInt(triggerId)]);
  }

  async sell(positionId: string, kind: SellKind, price: SignedResponse): Promise<Sold> {
    const { hash, logs } = await this.send('sell', [BigInt(positionId), SELL_KINDS.indexOf(kind), toSubmission(price)]);
    const { args } = readEvent(logs, 'PositionSold');
    const position = this.positions.get(positionId);
    if (position) position.open = false;
    return { positionId, usdcOut: args.usdcOut, price: args.price, txHash: hash };
  }
}
