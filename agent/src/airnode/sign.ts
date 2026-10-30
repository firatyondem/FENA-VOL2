import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { responseDigest, type SignedResponse } from './attestation.ts';

// Signs a response the way an Airnode v2 does: EIP-191 over keccak256(requestHash, timestamp, data). Used for test
// fixtures and for the wrong-signer tamper test; a real response always comes from the Airnode itself.
export const signResponse = async (
  privateKey: Hex,
  requestHash: Hex,
  timestamp: number,
  data: string
): Promise<SignedResponse> => {
  const account = privateKeyToAccount(privateKey);
  const unsigned = { requestHash, timestamp: timestamp.toString(), data };
  const signature = await account.signMessage({ message: { raw: responseDigest(unsigned) } });
  return { airnode: account.address, ...unsigned, signature };
};
