// The signed fixtures that the vault tests and the tamper demo use. Everything is deterministic: fixed times, fixed
// keys and RFC 6979 signatures, so regenerating gives byte-identical files.
import { type Hex, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type AirnodeRequest, deriveRequestHash, type SignedResponse } from '../src/airnode/attestation.ts';
import { signResponse } from '../src/airnode/sign.ts';
import { getAsset, priceRequest, type Profiles } from '../src/profiles.ts';
import { latestTweetRequest, snowflakeAt } from '../src/sources/twitter.ts';

// Public test-only keys, derived from public phrases. They stand in for the TwitterAPI.io and price Airnodes, and for
// an attacker who signs with their own key. Never fund them or use them anywhere real.
export const FIXTURE_AIRNODE_KEY = keccak256(toHex('api3-fena fixture airnode | test only'));
export const ATTACKER_KEY = keccak256(toHex('api3-fena attacker | test only'));

// Friday 2026-10-30 17:20:00 UTC, while the oil and stock markets are open
export const TWEET_TIME = Date.UTC(2026, 9, 30, 17, 20, 0) / 1000;
export const P0_TIME = TWEET_TIME + 120;

// The ETH demo rule the fixtures are built for (spec: demo rules use 2 min -> 10 min)
export const DEMO_ETH_RULE = { trendThresholdBps: 300, spikeCapBps: 1200, minWaitSec: 120, maxWindowSec: 600 };
export const DEMO_OIL_RULE = { trendThresholdBps: 150, spikeCapBps: 500, minWaitSec: 120, maxWindowSec: 600 };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => n.toString().padStart(2, '0');

// The X date format, "Fri Oct 30 17:20:00 +0000 2026"
export const formatXDate = (seconds: number) => {
  const d = new Date(seconds * 1000);
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())} ${time} +0000 ${d.getUTCFullYear()}`;
};

// The projected data as the Airnode writes it: one flat object, keys in code point order, no whitespace.
const tweetData = (author: string, createdAt: number, sequence: bigint, text: string) =>
  JSON.stringify({ author, createdAt: formatXDate(createdAt), id: snowflakeAt(createdAt, sequence), text });

const priceData = (price: string, updatedAtSec: number) => `{"price":${price},"updatedAt":${updatedAtSec * 1000}}`;

export type Expectation =
  | 'accept'
  | 'reject: signature invalid'
  | 'reject: too old / outside window'
  | 'reject: wrong request hash'
  | 'reject: unexpected signer'
  | 'reject: tweet too old for P0'
  | 'reject: below trend threshold'
  | 'reject: above spike cap'
  | 'reject: before minimum wait'
  | 'reject: after maximum window';

export interface FixtureCase {
  file: string;
  role: 'tweet' | 'p0' | 'p1' | 'price';
  request: string;
  expect: Expectation;
  note: string;
  response: SignedResponse;
}

export interface FixtureSet {
  manifest: Record<string, unknown>;
  cases: FixtureCase[];
}

export const buildFixtureSet = async (profiles: Profiles): Promise<FixtureSet> => {
  const airnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
  const attacker = privateKeyToAccount(ATTACKER_KEY).address;
  const requests: Record<string, AirnodeRequest> = {
    'tweet:realDonaldTrump': latestTweetRequest({ handle: 'realDonaldTrump', pinned: false }),
    'tweet:elonmusk': latestTweetRequest({ handle: 'elonmusk', pinned: false }),
    'price:ETH': priceRequest(getAsset(profiles, 'ETH')),
    'price:BTC': priceRequest(getAsset(profiles, 'BTC')),
    'price:OIL': priceRequest(getAsset(profiles, 'OIL')),
  };
  const hash = (name: string) => deriveRequestHash(requests[name] as AirnodeRequest);
  const sign = (key: Hex, name: string, signedAt: number, data: string) => signResponse(key, hash(name), signedAt, data);

  const ethP1Rise = await sign(FIXTURE_AIRNODE_KEY, 'price:ETH', P0_TIME + 301, priceData('2070', P0_TIME + 300));
  const cases: FixtureCase[] = [
    {
      file: 'tweet-trump-venezuela.json',
      role: 'tweet',
      request: 'tweet:realDonaldTrump',
      expect: 'accept',
      note: 'Keyword-free oil post: an LLM links Venezuela to oil supply',
      response: await sign(
        FIXTURE_AIRNODE_KEY,
        'tweet:realDonaldTrump',
        TWEET_TIME + 60,
        tweetData('realDonaldTrump', TWEET_TIME, 1n, 'We are coming for Venezuela. Big things are happening!')
      ),
    },
    {
      file: 'tweet-musk-doge.json',
      role: 'tweet',
      request: 'tweet:elonmusk',
      expect: 'accept',
      note: 'Non-ASCII text, to check that the signed bytes are UTF-8',
      response: await sign(
        FIXTURE_AIRNODE_KEY,
        'tweet:elonmusk',
        TWEET_TIME + 60,
        tweetData('elonmusk', TWEET_TIME, 2n, 'Ðogecoin is the people’s crypto')
      ),
    },
    {
      file: 'tweet-trump-old.json',
      role: 'tweet',
      request: 'tweet:realDonaldTrump',
      expect: 'reject: tweet too old for P0',
      note: 'Fresh signature over a two-day-old post: P0 is not within 10 min of its creation',
      response: await sign(
        FIXTURE_AIRNODE_KEY,
        'tweet:realDonaldTrump',
        TWEET_TIME + 60,
        tweetData('realDonaldTrump', TWEET_TIME - 2 * 86400, 3n, 'Iran sanctions are coming. Watch!')
      ),
    },
    {
      file: 'eth-p0.json',
      role: 'p0',
      request: 'price:ETH',
      expect: 'accept',
      note: 'P0 two minutes after the tweet',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:ETH', P0_TIME + 1, priceData('2000', P0_TIME)),
    },
    {
      file: 'eth-p1-rise.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'accept',
      note: '+3.5% after 5 min: above the 3% threshold, below the 12% cap',
      response: ethP1Rise,
    },
    {
      file: 'eth-p1-flat.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'reject: below trend threshold',
      note: '+0.5% after 5 min',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:ETH', P0_TIME + 301, priceData('2010', P0_TIME + 300)),
    },
    {
      file: 'eth-p1-spike.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'reject: above spike cap',
      note: '+15% after 5 min: a pump the spike cap refuses',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:ETH', P0_TIME + 301, priceData('2300', P0_TIME + 300)),
    },
    {
      file: 'eth-p1-early.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'reject: before minimum wait',
      note: '+3.5% after 1 min',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:ETH', P0_TIME + 61, priceData('2070', P0_TIME + 60)),
    },
    {
      file: 'eth-p1-late.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'reject: after maximum window',
      note: '+3.5% after 15 min',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:ETH', P0_TIME + 901, priceData('2070', P0_TIME + 900)),
    },
    {
      file: 'oil-p0.json',
      role: 'p0',
      request: 'price:OIL',
      expect: 'accept',
      note: 'WTI P0 in the TickerLayer projection',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:OIL', P0_TIME + 1, priceData('70.25', P0_TIME)),
    },
    {
      file: 'oil-p1-rise.json',
      role: 'p1',
      request: 'price:OIL',
      expect: 'accept',
      note: '+1.64% after 5 min: above the 1.5% threshold, below the 5% cap',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:OIL', P0_TIME + 301, priceData('71.4', P0_TIME + 300)),
    },
    {
      file: 'tamper-edited-value.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'reject: signature invalid',
      note: 'eth-p1-rise with the price changed after signing',
      response: { ...ethP1Rise, data: ethP1Rise.data.replace('"price":2070', '"price":2170') },
    },
    {
      file: 'tamper-stale.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'reject: too old / outside window',
      note: 'A genuine signature from a day before the trigger',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:ETH', P0_TIME - 86400, priceData('2070', P0_TIME - 86401)),
    },
    {
      file: 'tamper-different-request.json',
      role: 'p1',
      request: 'price:BTC',
      expect: 'reject: wrong request hash',
      note: 'A valid BTC price submitted where the ETH request is expected',
      response: await sign(FIXTURE_AIRNODE_KEY, 'price:BTC', P0_TIME + 301, priceData('80000', P0_TIME + 300)),
    },
    {
      file: 'tamper-wrong-signer.json',
      role: 'p1',
      request: 'price:ETH',
      expect: 'reject: unexpected signer',
      note: 'eth-p1-rise data signed with our own key',
      response: await sign(ATTACKER_KEY, 'price:ETH', P0_TIME + 301, priceData('2070', P0_TIME + 300)),
    },
  ];

  const manifest = {
    $comment:
      'Generated by agent/scripts/make-fixtures.ts. TEST ONLY: the keys below are public. In vault tests, expect fixtureAirnode as the Airnode for both tweets and prices.',
    fixtureAirnode: { address: airnode, privateKey: FIXTURE_AIRNODE_KEY },
    attacker: { address: attacker, privateKey: ATTACKER_KEY },
    times: { tweetCreatedAt: TWEET_TIME, p0SourceTime: P0_TIME, maxTweetToP0Sec: profiles.maxTweetToP0Sec },
    rules: { ETH: DEMO_ETH_RULE, OIL: DEMO_OIL_RULE },
    requests: Object.fromEntries(
      Object.entries(requests).map(([name, request]) => [name, { request, requestHash: hash(name) }])
    ),
    cases: cases.map(({ file, role, request, expect, note }) => ({ file, role, request, expect, note })),
  };
  return { manifest, cases };
};

export const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
