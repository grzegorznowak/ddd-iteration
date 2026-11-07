import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  artifacts as a, bundle, cli, commitRound, healthy, prepareFixture, readJSON,
  resumeConfig, ROLE_SLOTS, roleOutput, tamper, workflow,
} from './support.mjs';

// Scratch-only analogue of round 4: 17 committed answers, with SQ2/SQ5 r4
// recorded only in the unfinished round's 19-answer manifest. No live evidence.
function pendingAttemptFixture() {
  const f = prepareFixture();
  const artifacts = bundle();
  artifacts.open_questions = ['SQ2', 'SQ5', ...Array.from({ length: 11 }, (_, i) => `Q${i + 1}`)]
    .map((id) => ({ id, question: `Who owns ${id}?`, blocking: true }));
  let latest = commitRound(f.prepared, roleOutput('synthesis', { artifacts })).committed.latest;
  for (let revision = 1; revision <= 3; revision++) {
    const ids = revision === 1 ? artifacts.open_questions.map((q) => q.id) : ['SQ2', 'SQ5'];
    const config = resumeConfig(f, latest, {
      name: `answers-r${revision}.json`,
      answers: ids.map((question_id) => ({ question_id, answer: `${question_id} approved revision ${revision}.` })),
    });
    const prepared = a.prepare({ config_path: config });
    latest = commitRound(prepared, roleOutput('synthesis', { artifacts })).committed.latest;
  }
  const pendingConfig = resumeConfig(f, latest, {
    name: 'pending.json',
    answers: ['SQ2', 'SQ5'].map((question_id) => ({ question_id, answer: `${question_id} approved revision 4.` })),
  });
  const pending = a.prepare({ config_path: pendingConfig });
  const begun = a.begin({ latest, human_answers: pending.snapshot.human_answers });
  for (const slot of ROLE_SLOTS.slice(0, -1)) a.stage({ attempt: begun.attempt, slot, output: roleOutput(slot) });
  return { ...f, latest, pending, attempt: begun.attempt };
}

function assertPrepareRefused(f, config, code) {
  const beforeFiles = readdirSync(f.outputPath).sort();
  const beforeManifest = readFileSync(join(f.attempt, 'attempt.json'));
  const result = cli('prepare', { config_path: config });
  assert.equal(result.status, 1);
  assert.equal(result.packet.ok, false);
  assert.equal(result.packet.error.code, code, result.packet.error.message);
  assert.deepEqual(readdirSync(f.outputPath).sort(), beforeFiles, 'no input projection or snapshot published');
  assert.deepEqual(readFileSync(join(f.attempt, 'attempt.json')), beforeManifest, 'attempt stays unchanged');
}

test('attempt prepare carries pending SQ2/SQ5 revision 4 through native input transport and synthesis', () => {
  const f = pendingAttemptFixture();
  const base = a.loadSnapshot(f.latest.path);
  assert.equal(base.snapshot.human_answers.length, 17);
  assert.equal(f.pending.snapshot.human_answers.length, 19);
  // Relative paths are resolved from the config directory, not process cwd.
  const config = resumeConfig(f, f.latest, { attempt: relative(f.directory, f.attempt) });
  const manifestBefore = readFileSync(join(f.attempt, 'attempt.json'));
  const prepared = a.prepare({ config_path: config });
  assert.equal(prepared.attempt, f.attempt);
  assert.deepEqual(prepared.latest, f.latest);
  assert.deepEqual(prepared.snapshot, f.pending.snapshot);
  assert.deepEqual(prepared.snapshot.human_answers.slice(-2).map((row) => [row.question_id, row.revision]),
    [['SQ2', 4], ['SQ5', 4]]);

  const transported = cli('prepare', { config_path: config });
  assert.equal(transported.status, 0);
  assert.equal(transported.packet.ok, true);
  const { input_ref } = transported.packet.data;
  let raw = '';
  while (raw.length < input_ref.length) raw += a.inputChunk({ input_ref, offset: raw.length }).text;
  assert.deepEqual(JSON.parse(raw), f.pending.snapshot);
  assert.deepEqual(readFileSync(join(f.attempt, 'attempt.json')), manifestBefore);

  let calls = 0;
  const result = workflow(f, { args: config, runStub: (_prompt, options) => {
    calls++;
    assert.equal(options.input.phase, 'synthesize');
    assert.deepEqual(options.input.snapshot, f.pending.snapshot);
    return { output: roleOutput('synthesis', { artifacts: f.pending.snapshot.artifacts }) };
  } });
  healthy(result, 'needs-human');
  assert.equal(calls, 1, 'only missing synthesis runs in the offline harness');
  assert.equal(result.calls.run.length, 1);
  assert.equal(result.exit.round, 5);
  assert.deepEqual(readJSON(result.exit.latest_snapshot).human_answers, f.pending.snapshot.human_answers);
  assert.deepEqual(a.loadSnapshot(f.latest.path, { allowStale: true }).snapshot, base.snapshot);
});

for (const [name, code, change] of [
  ['unsupported manifest schema', 'E_SCHEMA', (m) => { m.schema_version = -1; }],
  ['invalid attempt round', 'E_LINEAGE', (m) => { m.round++; }],
  ['base hash mismatch', 'E_LINEAGE', (m) => { m.base.sha256 = '0'.repeat(64); }],
  ['changed committed answer history', 'E_LINEAGE', (m) => { m.human_answers[0].answer = 'Changed.'; }],
  ['unknown pending question', 'E_INPUT', (m) => {
    m.human_answers.push({ question_id: 'Unknown', question: 'Unknown?', answer: 'No.', revision: 1, attribution: 'human' });
  }],
  ['changed pending question wording', 'E_LINEAGE', (m) => { m.human_answers.at(-1).question = 'Changed?'; }],
]) {
  test(`attempt prepare rejects ${name} before input publication`, () => {
    const f = pendingAttemptFixture();
    tamper(join(f.attempt, 'attempt.json'), change);
    const config = resumeConfig(f, f.latest, { attempt: f.attempt });
    assertPrepareRefused(f, config, code);
  });
}

test('attempt prepare rejects an invalid attempt directory before input publication', () => {
  const f = pendingAttemptFixture();
  const config = resumeConfig(f, f.latest, { attempt: join(f.outputPath, 'not-an-attempt') });
  assertPrepareRefused(f, config, 'E_INPUT');
});

test('attempt prepare rejects a valid attempt from another lineage before input publication', () => {
  const f = pendingAttemptFixture();
  const other = pendingAttemptFixture();
  const otherFiles = readdirSync(other.outputPath).sort();
  const otherManifest = readFileSync(join(other.attempt, 'attempt.json'));
  const config = resumeConfig(f, f.latest, { attempt: other.attempt });
  assertPrepareRefused(f, config, 'E_LINEAGE');
  assert.deepEqual(readdirSync(other.outputPath).sort(), otherFiles);
  assert.deepEqual(readFileSync(join(other.attempt, 'attempt.json')), otherManifest);
});

test('attempt prepare rejects a stale attempt against the new latest before input publication', () => {
  const f = pendingAttemptFixture();
  const committed = commitRound(f.pending, roleOutput('synthesis', { artifacts: f.pending.snapshot.artifacts })).committed;
  const config = resumeConfig(f, committed.latest, { attempt: f.attempt });
  assertPrepareRefused(f, config, 'E_STALE');
  assert.equal(basename(committed.latest.path), 'round-0005.json');
});
