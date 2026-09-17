import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { PROVIDER_HOST_ADMINISTRATION_ERROR_CODES } from '#src/coordinator/services/provider-host-administration.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const DISPATCH_PATH = 'src/transport/dispatch.ts';
const DISPATCH_SET_NAME = 'PROVIDER_HOST_ADMINISTRATION_ERROR_CODES';

/** Transport may not import the coordinator (`tests/invariants/architecture-layering.test.ts`), so the copy
 *  it renders operator prose from is read out of its source instead of imported. */
function dispatchErrorCodes(): readonly string[] {
  const path = resolve(REPO_ROOT, DISPATCH_PATH);
  const sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const codes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === DISPATCH_SET_NAME) {
      codes.push(...collectStringLiterals(node.initializer ?? node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return codes;
}

function collectStringLiterals(node: ts.Node): string[] {
  const literals: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isStringLiteralLike(current)) literals.push(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return literals;
}

describe('provider-host administration error-code vocabulary', () => {
  it('renders operator copy for exactly the codes the owning service declares', () => {
    const rendered = dispatchErrorCodes();
    expect(rendered).not.toEqual([]);
    expect([...rendered].sort()).toEqual([...PROVIDER_HOST_ADMINISTRATION_ERROR_CODES].sort());
  });
});
