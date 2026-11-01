import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { WORKFLOW } from './support.mjs';

// Optional, no install and no copied compiler:
// ARCHITECTURE_COMPILER=/absolute/pi-schematic/workflow/compile.ts \
// ARCHITECTURE_COMPILER_DEPENDENCIES=/exact/installed/pi-schematic/package.json \
// node --test workflows/architecture-iteration/test/compile.test.mjs
// Only acorn, acorn-walk and magic-string are resolved through that explicit
// dependency anchor. The source compiler and all other resolution stay unchanged.
const compilerPath = process.env.ARCHITECTURE_COMPILER;
test('actual selected pi-schematic source compiler accepts the workflow', {
  skip: compilerPath ? false : 'Set ARCHITECTURE_COMPILER to opt into a real source compiler check.',
}, async () => {
  assert.ok(compilerPath.startsWith('/'), 'Use an absolute compiler source path.');
  const compilerURL = pathToFileURL(resolve(compilerPath)).href;
  const dependencyAnchor = process.env.ARCHITECTURE_COMPILER_DEPENDENCIES;
  let hook;
  if (dependencyAnchor) {
    assert.ok(dependencyAnchor.startsWith('/'), 'Use an explicit absolute dependency anchor.');
    const require = createRequire(dependencyAnchor);
    const allowed = new Set(['acorn', 'acorn-walk', 'magic-string']);
    hook = registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL === compilerURL && allowed.has(specifier)) {
        return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    } });
  }
  try {
    const { compileWorkflow } = await import(compilerURL);
    assert.equal(typeof compileWorkflow, 'function');
    const source = readFileSync(WORKFLOW, 'utf8');
    const result = compileWorkflow(source);
    assert.equal(result.hasCheckpoint, true);
    assert.match(result.code, /await workflow\.new\(\)/);
    assert.match(result.code, /await workflow\.run\(/);
    assert.match(result.code, /await workflow\.shell\(/);
    assert.match(result.code, /await workflow\.checkpoint\(/);
    assert.equal(typeof new Function('defineWorkflow', 'load', result.code), 'function');
    assert.notEqual(result.code, source, 'Compile the actual source, not a precompiled substitute.');
  } finally {
    hook?.deregister();
  }
});
