import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createOverlayProgram,
  createProgramOver,
  describeDiagnostic,
  productionProgram,
  sourceFileDiagnostics,
} from '#tests/helpers/ts-production-program.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BROKEN_PATH = 'src/ts-production-program-broken-overlay.ts';
const CLEAN_PATH = 'src/ts-production-program-clean-overlay.ts';
const OVERLAYS = new Map([
  [BROKEN_PATH, `export const hoursWaited: number = 'not a number';\n`],
  [
    CLEAN_PATH,
    `import { hoursWaited } from './ts-production-program-broken-overlay.js';\n\nexport const echoed = hoursWaited;\n`,
  ],
]);

const CHOSEN_ROOT = 'src/cli/bootstrap.ts';
const CHOSEN_ROOT_IMPORT = 'src/cli/run.ts';

const ABSENT_DIRECTORY = 'src/ts-production-program-absent-directory';
const ABSENT_DIRECTORY_OVERLAYS = new Map([
  [`${ABSENT_DIRECTORY}/entry.ts`, `import { value } from './leaf.js';\n\nexport const echoed: number = value;\n`],
  [`${ABSENT_DIRECTORY}/leaf.ts`, `export const value = 3;\n`],
]);

describe('ts-production-program', () => {
  it('should hand every case in a worker process the same production program', () => {
    expect(productionProgram()).toBe(productionProgram());
  });

  it('should scope diagnostics to the file asked about', () => {
    const program = createOverlayProgram(OVERLAYS);

    expect(sourceFileDiagnostics(program, BROKEN_PATH).map(describeDiagnostic)).toEqual([
      expect.stringContaining("TS2322: Type 'string' is not assignable to type 'number'."),
    ]);
    expect(sourceFileDiagnostics(program, CLEAN_PATH).map(describeDiagnostic)).toEqual([]);
  });

  it('should compile the overlays alone', () => {
    const program = createOverlayProgram(OVERLAYS);

    expect([...program.getRootFileNames()].sort()).toEqual(
      [resolve(REPO_ROOT, BROKEN_PATH), resolve(REPO_ROOT, CLEAN_PATH)].sort(),
    );
    expect(program.getSourceFile(resolve(REPO_ROOT, 'src/cli/bootstrap.ts'))).toBeUndefined();
  });

  it('should root the chosen set alone and reach the rest of production through imports', () => {
    const program = createProgramOver([resolve(REPO_ROOT, CHOSEN_ROOT)]);

    expect(program.getRootFileNames()).toEqual([resolve(REPO_ROOT, CHOSEN_ROOT)]);
    expect(program.getSourceFile(resolve(REPO_ROOT, CHOSEN_ROOT_IMPORT))).toBeDefined();
  });

  it('should add the overlays to a chosen root set', () => {
    const program = createProgramOver([resolve(REPO_ROOT, CHOSEN_ROOT)], OVERLAYS);

    expect([...program.getRootFileNames()].sort()).toEqual(
      [resolve(REPO_ROOT, CHOSEN_ROOT), resolve(REPO_ROOT, BROKEN_PATH), resolve(REPO_ROOT, CLEAN_PATH)].sort(),
    );
  });

  it('should resolve an overlay that imports a sibling from a directory no one created', () => {
    const program = createOverlayProgram(ABSENT_DIRECTORY_OVERLAYS);

    expect(sourceFileDiagnostics(program, `${ABSENT_DIRECTORY}/entry.ts`).map(describeDiagnostic)).toEqual([]);
  });
});
