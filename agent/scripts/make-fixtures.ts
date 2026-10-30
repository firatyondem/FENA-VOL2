// Writes the synthetic signed fixtures to shared/fixtures/synthetic/. Run with `npm run fixtures`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadProfiles } from '../src/profiles.ts';
import { buildFixtureSet, serialize } from './fixture-set.ts';

const directory = new URL('../../shared/fixtures/synthetic/', import.meta.url);
mkdirSync(directory, { recursive: true });

const { manifest, cases } = await buildFixtureSet(loadProfiles());
for (const { file, response } of cases) writeFileSync(new URL(file, directory), serialize(response));
writeFileSync(new URL('manifest.json', directory), serialize(manifest));
console.log(`Wrote ${cases.length} fixtures and manifest.json to shared/fixtures/synthetic/`);
