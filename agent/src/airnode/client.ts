// Calls an Airnode v2 and pays for priced operations over x402. The payment wiring follows
// api3dao/airnodehub-hackathon-starter (MIT), src/x402.ts.
import { ExactEvmScheme } from '@x402/evm';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { type Hex, isAddress, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AirnodeRequest, SignedResponse } from './attestation.ts';

// Base Sepolia, where the Airnodes take payment, so a priced call costs nothing real.
export const BASE_SEPOLIA = 'eip155:84532';

// AirnodeHub USD (aUSD), the only asset the Airnodes accept, from the hackathon faucet. It has 6 decimals.
export const AUSD_ADDRESS = '0xbeA34973e5f67F18F656A2C6070C64326C791808';

// A tweet costs 0.01 aUSD and a TickerLayer price 0.05, so one dollar a call is a generous ceiling.
const MAX_USD_PER_PAYMENT = '$1';
const MAX_AUSD_PER_PAYMENT = '1000000';

export class AirnodeHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(
      status === 402
        ? 'The operation is priced and answered 402. Set PAYER_PRIVATE_KEY to an account that holds testnet aUSD on Base Sepolia'
        : `The Airnode responded with ${status}: ${body}`
    );
    this.name = 'AirnodeHttpError';
    this.status = status;
  }
}

const isSignedResponse = (value: unknown): value is SignedResponse => {
  if (value === null || typeof value !== 'object') return false;
  const { airnode, requestHash, timestamp, data, signature } = value as Record<string, unknown>;
  return (
    typeof airnode === 'string' &&
    isAddress(airnode) &&
    typeof requestHash === 'string' &&
    isHex(requestHash) &&
    typeof timestamp === 'string' &&
    typeof data === 'string' &&
    typeof signature === 'string' &&
    isHex(signature)
  );
};

export const fetchSignedResponse = async (
  airnodeUrl: string,
  request: AirnodeRequest,
  fetchFunction: typeof fetch = fetch
): Promise<SignedResponse> => {
  const response = await fetchFunction(airnodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new AirnodeHttpError(response.status, await response.text());

  const body: unknown = await response.json();
  if (!isSignedResponse(body)) throw new Error(`The Airnode at ${airnodeUrl} answered without a signed response`);
  return body;
};

// Answers a 402 by signing the aUSD payment the Airnode asks for and sending the call again. The payer needs aUSD on
// Base Sepolia but no ETH, because the facilitator submits the transfer.
export const createPayingFetch = (payerPrivateKey: Hex, fetchFunction: typeof fetch = fetch): typeof fetch =>
  wrapFetchWithPaymentFromConfig(fetchFunction, {
    schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmScheme(privateKeyToAccount(payerPrivateKey)) }],
    spendControls: {
      maxAmountPerPayment: MAX_USD_PER_PAYMENT,
      allowedAssets: [{ network: BASE_SEPOLIA, asset: AUSD_ADDRESS, maxAmountPerPayment: MAX_AUSD_PER_PAYMENT }],
    },
    policies: [
      (_x402Version, requirements) =>
        requirements.filter((requirement) => requirement.asset.toLowerCase() === AUSD_ADDRESS.toLowerCase()),
    ],
  });

// A paid call carries its settlement, such as the transaction that moved the aUSD, in PAYMENT-RESPONSE.
export const readPaymentSettlement = (response: Response) => {
  const header = response.headers.get('PAYMENT-RESPONSE');
  return header ? decodePaymentResponseHeader(header) : undefined;
};

// Reports each settled payment, so the console can show what the agent spent on data.
export const withSettlementReporting =
  (payingFetch: typeof fetch, report: (transaction: string) => void): typeof fetch =>
  async (input, init) => {
    const response = await payingFetch(input, init);
    const settlement = readPaymentSettlement(response);
    if (settlement?.success) report(settlement.transaction);
    return response;
  };
