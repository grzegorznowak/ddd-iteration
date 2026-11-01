import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifacts as a, clone, prepareFixture, fixture, bundle, resolution, roleOutput,
  commitRound as rawCommitRound, stageRound, healthy, workflow, snapshots, readJSON,
} from './support.mjs';

// finish returns only a durable ref; load the projection for assertions.
function commitRound(prepared, output) {
  const staged = rawCommitRound(prepared, output);
  return { ...staged, committed: { ...staged.committed, ...a.loadSnapshot(staged.committed.latest.path) } };
}

// Pre-mint gate: synthesis closes or demotes questions the packet already
// answers, merges duplicate intents under existing IDs, and lets only genuinely
// unresolved authority gaps become blocking. The engine enforces the structural
// parts deterministically; these tests pin that behavior offline.

test('engine rejects verbatim duplicate question text within one synthesis', () => {
  const value = bundle({ question: true });
  value.open_questions.push({ id: 'Q2', question: value.open_questions[0].question, blocking: false });
  assert.throws(() => a.validateArtifacts(value), (error) => {
    assert.equal(error.code, 'E_SCHEMA');
    assert.match(error.message, /Verbatim duplicate question text/);
    return true;
  });
});

test('verbatim duplicate text fails finish of a staged round, leaving no commit', () => {
  const f = prepareFixture();
  const value = bundle({ question: true });
  value.open_questions.push({ id: 'Q2', question: value.open_questions[0].question, blocking: false });
  const attempt = stageRound(f.prepared, roleOutput('synthesis', { artifacts: value }));
  assert.throws(() => attempt.finish(), (error) => {
    assert.equal(error.code, 'E_SCHEMA');
    return true;
  });
  assert.deepEqual(snapshots(f), ['round-0000.json']);
});

test('a gate-compliant synthesis closes an inferable question with a resolution and commits', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  assert.equal(first.snapshot.artifacts.open_questions.length, 1);
  assert.equal(first.snapshot.artifacts.open_questions[0].blocking, true);

  const closed = bundle();
  closed.question_resolutions = [resolution({
    question_id: 'Q1',
    question: 'Who can cancel an order?',
    resolution: 'The source assigns cancellation authority to Operations, closing this question.',
    evidence: ['source:L2'],
  })];
  const second = commitRound(first, roleOutput('synthesis', { artifacts: closed, disposition: 'candidate' })).committed;
  assert.equal(second.snapshot.artifacts.open_questions.length, 0);
  assert.equal(second.snapshot.artifacts.question_resolutions.length, 1);
  assert.equal(second.snapshot.artifacts.question_resolutions[0].question_id, 'Q1');
  assert.equal(second.disposition, 'candidate');
  assert.equal(readJSON(first.latest.path).artifacts.open_questions[0].blocking, true);
});

test('merge under an existing ID is accepted; minting a fresh verbatim ID is not', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;

  // Compliant merge: the duplicate intent reuses Q1, no new ID minted.
  const merged = clone(first.snapshot.artifacts);
  const committed = commitRound(first, roleOutput('synthesis', { artifacts: merged, disposition: 'continue' })).committed;
  assert.equal(committed.snapshot.artifacts.open_questions.length, 1);

  // Malformed: a new ID with verbatim same text is rejected deterministically.
  const bad = clone(first.snapshot.artifacts);
  bad.open_questions.push({ id: 'Q1b', question: bad.open_questions[0].question, blocking: false });
  assert.throws(() => a.validateRole('synthesis', { artifacts: bad, disposition: 'continue', rationale: 'x' }, first.snapshot),
    (error) => error.code === 'E_SCHEMA');
});

test('a genuinely unresolved authority gap stays open and blocking, forcing needs-human', () => {
  const f = fixture();
  const value = bundle({ question: true });
  value.open_questions[0].blocking = true;
  const result = workflow(f, { output: () => value, disposition: 'candidate' });
  healthy(result, 'needs-human');
  const committed = readJSON(result.exit.latest_snapshot);
  assert.equal(committed.artifacts.open_questions[0].blocking, true);
  assert.match(committed.rationale, /blocking questions remain/);
});
