import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOverlayProgram } from '#tests/helpers/ts-production-program.js';

import {
  createCallableClosureContext,
  type CallableClosureContext,
} from './provider-serviceability-decision-inventory.js';

export const SERVICEABILITY_MUTATION_ENV = 'CORAL_SERVICEABILITY_INVARIANT_MUTATION';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/provider-serviceability-call-closure/', import.meta.url));

function fixtureSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return fixtureSourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts.txt') ? [path] : [];
  });
}

/**
 * The fixture is checked under the build's own options, like every other invariant program, so a symbol
 * the checker resolves in a `.ts.txt` mutation resolves the same way in the production source it stands
 * in for.
 */
export function serviceabilityMutationFixtureContext(): CallableClosureContext {
  const sources = new Map(
    fixtureSourceFiles(join(FIXTURE_ROOT, 'src')).map((fixturePath) => [
      resolve(fixturePath.slice(0, -'.txt'.length)),
      readFileSync(fixturePath, 'utf8'),
    ]),
  );
  const program = createOverlayProgram(sources);
  return createCallableClosureContext(FIXTURE_ROOT, [...sources.keys()], program);
}

export function activeServiceabilityMutation(): string | undefined {
  const selected = process.env[SERVICEABILITY_MUTATION_ENV];
  return selected === undefined || selected.length === 0 ? undefined : selected;
}

export function fixturePath(fileName: string): string {
  return `src/${fileName}`;
}
