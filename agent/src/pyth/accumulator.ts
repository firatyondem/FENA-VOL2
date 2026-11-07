// Reads Pyth's accumulator update format ("PNAU"), the bytes that Hermes serves and the Pyth contract verifies. The agent
// reads the price messages to decide before it pays gas; the vault never trusts this reading, Pyth verifies the
// signatures on-chain. LocalPyth's unsigned updates (abi.encode(PriceFeed, prevPublishTime)) are read here too.
import { decodeAbiParameters, encodeAbiParameters, type Hex, hexToBytes, bytesToHex } from 'viem';

export interface PythPrice {
  // Pyth's feed ID, 0x-prefixed, lower case
  id: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
  prevPublishTime: number;
  emaPrice: bigint;
  emaConf: bigint;
}

const MAGIC = 0x504e4155; // "PNAU"

const readInt = (bytes: Uint8Array, start: number, length: number, signed: boolean) => {
  let value = 0n;
  for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(bytes[start + i] as number);
  const bits = BigInt(length * 8);
  return signed && value >> (bits - 1n) === 1n ? value - (1n << bits) : value;
};

// The price messages of one accumulator update, in the order of the update
export const readAccumulatorUpdate = (update: Hex): PythPrice[] => {
  const bytes = hexToBytes(update);
  if (Number(readInt(bytes, 0, 4, false)) !== MAGIC) throw new Error('not a Pyth accumulator update');
  let at = 6; // magic, major and minor version
  at += 1 + (bytes[at] as number); // trailing header
  at += 1; // update type: Wormhole merkle
  const vaaLength = Number(readInt(bytes, at, 2, false));
  at += 2 + vaaLength;
  const count = bytes[at] as number;
  at += 1;
  const prices: PythPrice[] = [];
  for (let i = 0; i < count; i++) {
    const messageLength = Number(readInt(bytes, at, 2, false));
    at += 2;
    const m = at;
    at += messageLength;
    at += 1 + 20 * (bytes[at] as number); // merkle proof
    if (bytes[m] !== 0) continue; // not a price message
    prices.push({
      id: bytesToHex(bytes.slice(m + 1, m + 33)),
      price: readInt(bytes, m + 33, 8, true),
      conf: readInt(bytes, m + 41, 8, false),
      expo: Number(readInt(bytes, m + 49, 4, true)),
      publishTime: Number(readInt(bytes, m + 53, 8, true)),
      prevPublishTime: Number(readInt(bytes, m + 61, 8, true)),
      emaPrice: readInt(bytes, m + 69, 8, true),
      emaConf: readInt(bytes, m + 77, 8, false),
    });
  }
  if (at !== bytes.length) throw new Error('Pyth update has trailing bytes');
  return prices;
};

const PRICE_FEED = [
  {
    type: 'tuple',
    components: [
      { name: 'id', type: 'bytes32' },
      {
        name: 'price',
        type: 'tuple',
        components: [
          { name: 'price', type: 'int64' },
          { name: 'conf', type: 'uint64' },
          { name: 'expo', type: 'int32' },
          { name: 'publishTime', type: 'uint256' },
        ],
      },
      {
        name: 'emaPrice',
        type: 'tuple',
        components: [
          { name: 'price', type: 'int64' },
          { name: 'conf', type: 'uint64' },
          { name: 'expo', type: 'int32' },
          { name: 'publishTime', type: 'uint256' },
        ],
      },
    ],
  },
  { type: 'uint64' },
] as const;

// An unsigned update for LocalPyth: tests, the replay and a local chain. Never valid on a real Pyth contract.
export const encodeLocalUpdate = (price: Omit<PythPrice, 'emaPrice' | 'emaConf'> & Partial<PythPrice>): Hex =>
  encodeAbiParameters(PRICE_FEED, [
    {
      id: price.id,
      price: { price: price.price, conf: price.conf, expo: price.expo, publishTime: BigInt(price.publishTime) },
      emaPrice: {
        price: price.emaPrice ?? price.price,
        conf: price.emaConf ?? price.conf,
        expo: price.expo,
        publishTime: BigInt(price.publishTime),
      },
    },
    BigInt(price.prevPublishTime),
  ]);

export const readLocalUpdate = (update: Hex): PythPrice => {
  const [feed, prevPublishTime] = decodeAbiParameters(PRICE_FEED, update);
  return {
    id: feed.id,
    price: feed.price.price,
    conf: feed.price.conf,
    expo: feed.price.expo,
    publishTime: Number(feed.price.publishTime),
    prevPublishTime: Number(prevPublishTime),
    emaPrice: feed.emaPrice.price,
    emaConf: feed.emaPrice.conf,
  };
};

// Either kind: a signed accumulator update or a LocalPyth one
export const readUpdate = (update: Hex): PythPrice[] =>
  update.toLowerCase().startsWith('0x504e4155') ? readAccumulatorUpdate(update) : [readLocalUpdate(update)];

// The price of `feedId` in a list of updates, as the vault picks it: the first one with that feed
export const findPrice = (updates: readonly Hex[], feedId: Hex): PythPrice | undefined => {
  for (const update of updates) {
    const match = readUpdate(update).find((price) => price.id.toLowerCase() === feedId.toLowerCase());
    if (match) return match;
  }
  return undefined;
};

// value * 10^(18 + expo), as the vault scales it
export const toPrice18 = (value: bigint, expo: number): bigint => {
  const shift = 18 + expo;
  return shift >= 0 ? value * 10n ** BigInt(shift) : value / 10n ** BigInt(-shift);
};
