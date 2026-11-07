// The tamper test's cases for an asset, all built from real Pyth updates: a fresh one that the vault accepts, the same one
// with the asset's price edited, an hour-old one, and another asset's. The website's judges page and `npm run
// tamper-demo` send each to the vault's checkPrice, which names its reason for every refusal. A replayed price is refused
// per user once it opened or confirmed a trigger, so checkPrice cannot show it; the fork test and the local stage do.
import { bytesToHex, type Hex, hexToBytes } from 'viem';
import type { TamperCase } from '../src/console/server.ts';
import { getAsset, type Profiles } from '../src/profiles.ts';
import type { PriceSource } from '../src/pyth/price-source.ts';

export type { TamperCase };

// The update with the last byte of `feedId`'s price changed, as an attacker would nudge it
export const editPrice = (updates: readonly Hex[], feedId: Hex): Hex[] => {
  const needle = hexToBytes(feedId);
  return updates.map((update) => {
    const bytes = hexToBytes(update);
    for (let i = 0; i + 32 <= bytes.length; i++) {
      if (needle.every((byte, k) => bytes[i + k] === byte)) {
        // The int64 price follows the 32-byte feed ID; its last byte is at +39
        bytes[i + 39] = ((bytes[i + 39] as number) ^ 0x01) & 0xff;
        return bytesToHex(bytes);
      }
    }
    return update;
  });
};

export const buildTamperSet = async (
  profiles: Profiles,
  prices: PriceSource,
  asset: string,
  nowSec: number,
  otherAsset = asset === 'BTC' ? 'ETH' : 'BTC'
): Promise<TamperCase[]> => {
  const feed = getAsset(profiles, asset).pyth.priceId;
  const [fresh, old, other] = await Promise.all([
    prices.latest(asset),
    prices.firstAt(asset, nowSec - 3600),
    prices.latest(otherAsset),
  ]);
  return [
    { name: 'Genuine', how: `A fresh ${asset} price from Pyth, as it is`, expected: 'accepted', update: fresh.updates },
    {
      name: 'Edited price',
      how: `The same update with the last byte of the ${asset} price changed`,
      expected: 'InvalidPriceUpdate',
      update: editPrice(fresh.updates, feed),
    },
    {
      name: 'Old price',
      how: `A genuine ${asset} update from an hour ago, past the five-minute limit`,
      expected: 'PriceTooOld',
      update: old.updates,
    },
    {
      name: 'Wrong asset',
      how: `A genuine ${otherAsset} update offered as ${asset}`,
      expected: 'WrongPriceFeed',
      update: other.updates,
    },
  ];
};
