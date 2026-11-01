import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { WORKFLOW } from './support.mjs';

// Optional, no install and no copied compiler:
// ARCHITECTURE_COMPILER=/absolute/pi-schematic/workflow/compile.ts \
// ARCHITECTURE_COMPILER_DEPENDENCIES=/exact/installed/pi-schematic/package.json \
// node --test test/compile.test.mjs
// Only acorn, acorn-walk and magic-string are resolved through that explicit
// dependency anchor. Source checkouts may import ./types.js before a build;
// resolve that one compiler-local import to its existing TypeScript source.
// No runtime, provider, generated compiler, or global loader is required.
const compilerPath = process.env.ARCHITECTURE_COMPILER;
test('actual selected pi-schematic source compiler accepts the workflow', {
  skip: compilerPath ? false : 'Set ARCHITECTURE_COMPILER to opt into a real source compiler check.',
}, async () => {
  assert.ok(compilerPath.startsWith('/'), 'Use an absolute compiler source path.');
  const compilerURL = pathToFileURL(resolve(compilerPath)).href;
  const dependencyAnchor = process.env.ARCHITECTURE_COMPILER_DEPENDENCIES;
  if (dependencyAnchor) assert.ok(dependencyAnchor.startsWith('/'), 'Use an explicit absolute dependency anchor.');
  const require = dependencyAnchor ? createRequire(dependencyAnchor) : null;
  const allowed = new Set(['acorn', 'acorn-walk', 'magic-string']);
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === compilerURL) {
      if (require && allowed.has(specifier)) {
        return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
      }
      if (specifier === './types.js') {
        const sourceURL = new URL('./types.ts', compilerURL);
        if (existsSync(fileURLToPath(sourceURL))) return { url: sourceURL.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  } });
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
