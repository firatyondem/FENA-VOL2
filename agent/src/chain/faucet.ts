// The demo faucet behind POST /api/demo/faucet: a little Base Sepolia ETH for gas and mock USDC for a deposit, sent to a
// demo address. At most once per address per UTC day and a fixed number of drips per day in total, so nobody can drain
// the faucet wallet. Its key lives only in the server's secrets (FAUCET_PRIVATE_KEY).
import {
  type Account,
  type Address,
  type Chain,
  getAddress,
  type Hash,
  isAddress,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { type Db, utcDate } from '../store/db.ts';
import { mockUsdcAbi } from './vault-abi.ts';

export interface FaucetSettings {
  ethPerDrip: bigint;
  // Mock USDC with 6 decimals
  usdcPerDrip: bigint;
  maxDripsPerDay: number;
  // The faucet stops before its own ETH falls below this
  minFaucetEth: bigint;
}

export class FaucetRefusal extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FaucetRefusal';
    this.status = status;
  }
}

export interface FaucetOptions {
  db: Db;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  usdc: Address;
  settings: FaucetSettings;
  nowMs?: () => number;
}

export interface Drip {
  address: Address;
  ethTx: Hash;
  usdcTx: Hash;
  eth: bigint;
  usdc: bigint;
}

export class Faucet {
  private readonly options: FaucetOptions;
  private readonly nowMs: () => number;

  constructor(options: FaucetOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? Date.now;
  }

  // Claims today's drip for `address` before any transaction, so two requests at once cannot both pass the limits
  private claim(address: Address): number {
    const { db, settings } = this.options;
    const day = utcDate(this.nowMs());
    const already = db.prepare('SELECT COUNT(*) AS n FROM faucet WHERE day = ? AND address = ?').get(day, address) as { n: number };
    if (already.n > 0) throw new FaucetRefusal(429, 'This address got its demo funds today; come back tomorrow (UTC)');
    const today = db.prepare('SELECT COUNT(*) AS n FROM faucet WHERE day = ?').get(day) as { n: number };
    if (today.n >= settings.maxDripsPerDay) throw new FaucetRefusal(429, 'The faucet gave out all of today’s demo funds');
    const result = db.prepare('INSERT INTO faucet (address, day, at) VALUES (?, ?, ?)').run(address, day, this.nowMs());
    return Number(result.lastInsertRowid);
  }

  async drip(raw: string): Promise<Drip> {
    if (typeof raw !== 'string' || !isAddress(raw)) throw new FaucetRefusal(400, 'Send {"address": "0x..."}');
    const address = getAddress(raw);
    const { db, publicClient, walletClient, usdc, settings } = this.options;
    const id = this.claim(address);
    try {
      const balance = await publicClient.getBalance({ address: walletClient.account.address });
      if (balance < settings.ethPerDrip + settings.minFaucetEth) {
        throw new FaucetRefusal(503, 'The faucet is out of test ETH for now');
      }
      const ethTx = await walletClient.sendTransaction({
        to: address,
        value: settings.ethPerDrip,
        account: walletClient.account,
        chain: walletClient.chain,
      });
      // From here the drip counts, even if the mint fails, so an address never gets the ETH twice
      db.prepare('UPDATE faucet SET eth_tx = ? WHERE id = ?').run(ethTx, id);
      const usdcTx = await walletClient.writeContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName: 'mint',
        args: [address, settings.usdcPerDrip],
        account: walletClient.account,
        chain: walletClient.chain,
      } as never);
      db.prepare('UPDATE faucet SET usdc_tx = ? WHERE id = ?').run(usdcTx, id);
      return { address, ethTx, usdcTx, eth: settings.ethPerDrip, usdc: settings.usdcPerDrip };
    } catch (error) {
      // Nothing was sent, so the address may try again
      db.prepare('DELETE FROM faucet WHERE id = ? AND eth_tx IS NULL').run(id);
      throw error;
    }
  }
}
