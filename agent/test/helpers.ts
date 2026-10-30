import { readFileSync } from 'node:fs';
import type { SignedResponse } from '../src/airnode/attestation.ts';

const sharedUrl = new URL('../../shared/', import.meta.url);

export const readSharedJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(new URL(relativePath, sharedUrl), 'utf8')) as T;

export const readFixture = (name: string) => readSharedJson<SignedResponse>(`fixtures/${name}`);

export const NODARY_ADDRESS = '0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0';
