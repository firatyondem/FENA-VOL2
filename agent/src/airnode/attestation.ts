// Request hashing and signature checks for Airnode v2 responses. The hashing and recovery follow
// api3dao/airnodehub-hackathon-starter (MIT), src/airnode-v2.ts, so the agent derives exactly the hashes that the vault
// stores and rejects a bad response before it costs gas.
import { type Address, encodePacked, type Hex, isAddressEqual, keccak256, recoverMessageAddress, toHex } from 'viem';

// The body of a POST to an Airnode v2: https://airnodehub-docs.api3.org/airnode/http-interface
export interface AirnodeRequest {
  operation: string;
  parameters: Record<string, unknown>;
  // Maps each field of the projected response to the JSON Pointer of its value in the full response.
  responseProjection?: Record<string, string>;
}

// A signed response with `data` as the exact string that the Airnode signed. The vault receives it as bytes.
export interface SignedResponse {
  airnode: Address;
  requestHash: Hex;
  timestamp: string;
  data: string;
  signature: Hex;
}

// What the vault takes for one signed response: the request hash and the Airnode come from its own storage.
export interface ResponseSubmission {
  timestamp: bigint;
  data: Hex;
  signature: Hex;
}

export type AttestationFailure = 'wrong-request' | 'wrong-signer' | 'malformed';

export class AttestationError extends Error {
  readonly reason: AttestationFailure;

  constructor(reason: AttestationFailure, message: string) {
    super(message);
    this.name = 'AttestationError';
    this.reason = reason;
  }
}

// The Airnode and Solidity compare strings in UTF-8 byte order, which is code point order.
const compareUtf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Sorts object keys at every depth, so the same request always has the same hash.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.entries(value)
    .toSorted(([a], [b]) => compareUtf8(a, b))
    .map(([key, nested]) => [key, canonicalize(nested)]);
};

// Needs no call to the Airnode, so the vault can store the hash before any response exists.
export const deriveRequestHash = ({ operation, parameters, responseProjection }: AirnodeRequest): Hex => {
  const request = [operation, canonicalize(parameters)];
  const hashed = responseProjection ? [...request, canonicalize(responseProjection)] : request;
  return keccak256(toHex(JSON.stringify(hashed)));
};

// keccak256(abi.encodePacked(bytes32 requestHash, uint256 timestamp, bytes data)), which the Airnode signs with EIP-191.
export const responseDigest = ({ requestHash, timestamp, data }: Pick<SignedResponse, 'requestHash' | 'timestamp' | 'data'>) =>
  keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [requestHash, BigInt(timestamp), toHex(data)]));

export const recoverSigner = (response: SignedResponse): Promise<Address> =>
  recoverMessageAddress({ message: { raw: responseDigest(response) }, signature: response.signature });

// Makes the same checks as AirnodeV2Attestation.verify with the vault's stored Airnode and request hash. The signer is
// recovered over `expectedRequestHash`, never over the hash that came with the response.
export const verifySignedResponse = async (
  response: SignedResponse,
  expectedAirnode: Address,
  expectedRequestHash: Hex
): Promise<void> => {
  if (!/^\d+$/.test(response.timestamp)) {
    throw new AttestationError('malformed', `The timestamp ${response.timestamp} is not a whole number of seconds`);
  }
  if (response.requestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
    throw new AttestationError(
      'wrong-request',
      `The response answers the request ${response.requestHash}, not ${expectedRequestHash}`
    );
  }
  let signer: Address;
  try {
    signer = await recoverSigner({ ...response, requestHash: expectedRequestHash });
  } catch (error) {
    throw new AttestationError('malformed', `The signature does not recover: ${(error as Error).message}`);
  }
  if (!isAddressEqual(signer, expectedAirnode)) {
    throw new AttestationError('wrong-signer', `The response is signed by ${signer}, not by ${expectedAirnode}`);
  }
};

// The signed `data` goes to the contract as its exact bytes, never parsed and written again.
export const toSubmission = ({ timestamp, data, signature }: SignedResponse): ResponseSubmission => ({
  timestamp: BigInt(timestamp),
  data: toHex(data),
  signature,
});
