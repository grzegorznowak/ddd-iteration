import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './harness.mjs';

// Retain this test's new temporary files; no workshop or prior evidence is removed.
function draft() {
  const file = join(mkdtempSync(join(tmpdir(), 'architecture-reset-harness-')), 'draft.js');
  writeFileSync(file, `return defineWorkflow((workflow) => {
    workflow.new();
    workflow.readonly(true);
    return workflow.exit({ state: workflow.state() });
  });`);
  return file;
}

test('shared harness reset stays trapped unless explicitly supplied', () => {
  const result = runWorkflow({ file: draft() });
  assert.match(result.error.message, /unexpected workflow\.new/);
  assert.equal(result.calls.new, 0);
  assert.equal(result.exit, null);
});

test('opt-in reset stub mutates the live state and records the effect before readonly', () => {
  const result = runWorkflow({ file: draft(), initialState: { readonly: true, sessionId: 'before' },
    newStub: ({ state, calls, pages }) => {
      assert.equal(calls.new, 1);
      assert.ok(pages instanceof Map);
      state.sessionId = 'after';
      state.readonly = false;
    },
  });
  assert.ifError(result.error);
  assert.equal(result.calls.new, 1);
  assert.equal(result.exit.state.sessionId, 'after');
  assert.equal(result.exit.state.readonly, true);
  assert.deepEqual(result.calls.order.map(({ handle }) => handle), ['new', 'readonly', 'state', 'exit']);
});

test('shared harness rejects asynchronous reset stubs', () => {
  const result = runWorkflow({ file: draft(), newStub: () => Promise.resolve() });
  assert.match(result.error.message, /newStub must be synchronous/);
  assert.equal(result.calls.new, 1);
  assert.equal(result.exit, null);
});
