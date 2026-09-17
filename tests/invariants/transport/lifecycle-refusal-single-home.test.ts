// `src/transport/lifecycle-refusal.ts` is the one home for the `backend_shutting_down` body. Two properties are
// asserted here, and the second is the one a caller's safety rests on.
//
//   1. Nothing else in `src/` constructs the code. Every other occurrence of the literal is a *recognizing*
//      position — `=== '…'`, `!== '…'`, or `case '…':` — so no handler can return a body carrying it and no
//      second spelling of the body can drift away from the canonical one.
//   2. In `src/transport/ipc/server.ts`, both writes of `lifecycleRefusalResult` appear textually above the
//      `dispatchMap.get(request.method)` lookup, and there are exactly two of them, so deleting a gate fails
//      here instead of quietly admitting a method the lifecycle refuses. Textual order is not execution
//      order: what this bounds is the shape of the file. That a refused method never executed — the property
//      re-issuing against a successor rests on — is asserted behaviourally instead; see
//      'keeps unrelated catalog methods closed while draining' in
//      tests/unit/transport/ipc/draining-recovery.test.ts.
//
// (1) is a text scan, and is bounded in the same way as `thrown-errno-single-home.test.ts`: a sufficiently
// indirect construction (a computed key, a string concatenation) evades it.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CANONICAL_FILE = 'src/transport/lifecycle-refusal.ts';
const IPC_SERVER_FILE = 'src/transport/ipc/server.ts';
const REFUSAL_CODE = 'backend_shutting_down';
const RECOGNIZING_POSITION = new RegExp(String.raw`(?:[=!]==\s*|case\s+)(['"\`])${REFUSAL_CODE}\1`, 'g');

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.ts')) {
        found.push(relative(ROOT, path));
      }
    }
  };
  walk(join(ROOT, 'src'));
  return found.sort();
}

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe('lifecycle refusal body single-home invariant', () => {
  it(`constructs the ${REFUSAL_CODE} body only in ${CANONICAL_FILE}`, () => {
    const canonical = readFileSync(join(ROOT, CANONICAL_FILE), 'utf-8');
    expect(canonical).toMatch(new RegExp(String.raw`code:\s*'${REFUSAL_CODE}'`));

    const constructors = sourceFiles()
      .filter((path) => path !== CANONICAL_FILE)
      .filter((path) => {
        const text = readFileSync(join(ROOT, path), 'utf-8');
        const mentions = countOccurrences(text, new RegExp(REFUSAL_CODE, 'g'));
        return mentions > countOccurrences(text, RECOGNIZING_POSITION);
      });

    expect(constructors).toEqual([]);
  });

  it('writes both lifecycle refusals above the IPC dispatch lookup', () => {
    const text = readFileSync(join(ROOT, IPC_SERVER_FILE), 'utf-8');
    const dispatchLookup = text.indexOf('dispatchMap.get(request.method)');
    // The write, not the import: matching the bare symbol would count the import line as a third gate.
    const refusalWrites = [...text.matchAll(/result: lifecycleRefusalResult/g)].map((match) => match.index);

    expect(dispatchLookup).toBeGreaterThan(-1);
    expect(refusalWrites).toHaveLength(2);
    expect(refusalWrites.filter((index) => index > dispatchLookup)).toEqual([]);
  });
});
