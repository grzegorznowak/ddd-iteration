import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  artifacts as a, clone, prepareFixture, bundle, resolution, roleOutput, commitRound as commitRawRound,
  stageRound, resumeConfig, readJSON, expectError, snapshots, tamper, cli,
} from './support.mjs';

// finish returns only a durable ref; explicitly load the projection for the next round.
function commitRound(prepared, output) {
  const staged = commitRawRound(prepared, output);
  return { ...staged, committed: { ...staged.committed, ...a.loadSnapshot(staged.committed.latest.path) } };
}
function withOpenQuestion() {
  const f = prepareFixture();
  return { ...f, first: commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed };
}
function closedBundle(rows = [resolution()]) {
  const value = bundle();
  value.question_resolutions = clone(rows);
  return value;
}
function withResolution() {
  const f = withOpenQuestion();
  const closed = closedBundle();
  return { ...f, closed, second: commitRound(f.first, roleOutput('synthesis', { artifacts: closed })).committed };
}
function replaceSynthesis(stored, transform) {
  transform(stored.role_outputs.synthesis);
  stored.artifacts = clone(stored.role_outputs.synthesis.artifacts);
  Object.assign(stored, a.deriveDisposition(stored.role_outputs.synthesis));
}

for (const blocking of [false, true]) for (const disposition of ['continue', 'candidate']) {
  test(`an omitted prior ${blocking ? 'blocking' : 'nonblocking'} question cannot silently become ${disposition}`, () => {
    const f = prepareFixture();
    const prior = bundle({ question: true });
    prior.open_questions[0].blocking = blocking;
    const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: prior })).committed;
    const output = roleOutput('synthesis', { disposition });
    expectError('E_LINEAGE', () => a.validateRole('synthesis', output, first.snapshot), /Q1.*new.*resolution/i);
    const attempt = stageRound(first, output);
    expectError('E_LINEAGE', () => attempt.finish());
    assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
    assert.equal(readJSON(first.latest.path).artifacts.open_questions[0].blocking, blocking);
  });
}

test('a prior blocker cannot be demoted without a new evidence-backed partial resolution', () => {
  const f = withOpenQuestion();
  const artifacts = clone(f.first.snapshot.artifacts);
  artifacts.open_questions[0].blocking = false;
  const output = roleOutput('synthesis', { artifacts, disposition: 'candidate' });
  expectError('E_LINEAGE', () => a.validateRole('synthesis', output, f.first.snapshot), /Demoting blocking question Q1/);
  expectError('E_LINEAGE', () => stageRound(f.first, output).finish());
  artifacts.question_resolutions.push(resolution({
    resolution: 'The source narrows the modeled scope; residual uncertainty is nonblocking.',
    evidence: ['source:L1'],
  }));
  const committed = commitRound(f.first, output).committed;
  assert.equal(committed.disposition, 'candidate');
  assert.equal(committed.snapshot.artifacts.open_questions[0].blocking, false);
  assert.equal(committed.snapshot.artifacts.question_resolutions.length, 1);
});

for (const [name, mutate, code] of [
  ['missing closure evidence', (row) => { delete row.evidence; }, 'E_SCHEMA'],
  ['empty closure evidence', (row) => { row.evidence = []; }, 'E_EVIDENCE'],
  ['non-array closure evidence', (row) => { row.evidence = 'source:L1'; }, 'E_SCHEMA'],
  ['non-string closure evidence', (row) => { row.evidence = [1]; }, 'E_SCHEMA'],
  ['blank closure evidence', (row) => { row.evidence = [' ']; }, 'E_SCHEMA'],
  ['outside-source closure evidence', (row) => { row.evidence = ['source:L999']; }, 'E_EVIDENCE'],
  ['invented human revision', (row) => { row.evidence = ['human:Q1:r1']; }, 'E_EVIDENCE'],
  ['external closure reference', (row) => { row.evidence = ['https://example.com/approval']; }, 'E_EVIDENCE'],
  ['blank resolution', (row) => { row.resolution = ' '; }, 'E_SCHEMA'],
  ['changed question wording', (row) => { row.question = 'Who can approve an order?'; }, 'E_LINEAGE'],
  ['different question ID', (row) => { row.question_id = 'Q2'; }, 'E_LINEAGE'],
]) test(`synthesis rejects ${name} instead of closing the prior question`, () => {
  const f = withOpenQuestion();
  const artifacts = closedBundle();
  mutate(artifacts.question_resolutions[0]);
  const output = roleOutput('synthesis', { artifacts, disposition: 'candidate' });
  expectError(code, () => a.validateRole('synthesis', output, f.first.snapshot));
  const staged = stageRound(f.first, output);
  expectError(code, () => staged.finish());
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

for (const [name, mutate] of [
  ['question ID reused while open', (v) => { v.open_questions[0].question = 'Who can approve an order?'; }],
  ['question ID reused after closure', (v) => { v.open_questions.push({ id: 'Q1', question: 'Who can approve an order?', blocking: false }); }],
]) test(`exact question binding rejects ${name}`, () => {
  const f = withResolution();
  const prior = name.includes('while') ? f.first : f.second;
  const artifacts = name.includes('while') ? bundle({ question: true }) : clone(f.closed);
  mutate(artifacts);
  expectError('E_LINEAGE', () => a.validateRole('synthesis', roleOutput('synthesis', { artifacts }), prior.snapshot), /exact question wording/);
});

for (const [name, mutate] of [
  ['history removed', (rows) => rows.splice(0)],
  ['resolution text rewritten', (rows) => { rows[0].resolution = 'New unsupported conclusion.'; }],
  ['closure wording rewritten', (rows) => { rows[0].question = 'What can cancel an order?'; }],
  ['evidence rewritten', (rows) => { rows[0].evidence = ['source:L1']; }],
  ['old record shifted behind a new one', (rows) => rows.unshift(resolution({ resolution: 'A new resolution inserted before history.' }))],
]) test(`cumulative question resolutions reject ${name}`, () => {
  const f = withResolution();
  const artifacts = clone(f.closed);
  mutate(artifacts.question_resolutions);
  expectError('E_LINEAGE', () => a.validateRole('synthesis', roleOutput('synthesis', { artifacts }), f.second.snapshot), /history/);
});

test('source-backed closure permits candidate and survives the next projected round unchanged', () => {
  const f = withOpenQuestion();
  const artifacts = closedBundle();
  const second = commitRound(f.first, roleOutput('synthesis', { artifacts, disposition: 'candidate' })).committed;
  assert.equal(second.disposition, 'candidate');
  const loaded = a.loadSnapshot(second.latest.path);
  assert.deepEqual(loaded.snapshot.artifacts.question_resolutions, [resolution()]);
  assert.deepEqual(loaded.snapshot.artifacts.open_questions, []);
  assert.equal(Object.hasOwn(loaded.snapshot, 'role_outputs'), false);
  const third = commitRound(loaded, roleOutput('synthesis', { artifacts })).committed;
  assert.deepEqual(a.loadSnapshot(third.latest.path).snapshot.artifacts.question_resolutions, [resolution()]);
});

test('a resolved question can reopen with the same wording, but needs a new closure record', () => {
  const f = withResolution();
  const reopened = clone(f.closed);
  reopened.open_questions = bundle({ question: true }).open_questions;
  const third = commitRound(f.second, roleOutput('synthesis', { artifacts: reopened, disposition: 'candidate' })).committed;
  assert.equal(third.disposition, 'needs-human');
  // A historical resolution is not evidence that this new occurrence was closed.
  expectError('E_LINEAGE', () => a.validateRole('synthesis', roleOutput('synthesis', { artifacts: f.closed, disposition: 'candidate' }), third.snapshot), /new.*resolution/);
  const resolvedAgain = clone(f.closed);
  resolvedAgain.question_resolutions.push(resolution({ resolution: 'Operations reaffirmed cancellation authority.', evidence: ['source:L1-L2'] }));
  const fourth = commitRound(third, roleOutput('synthesis', { artifacts: resolvedAgain, disposition: 'candidate' })).committed;
  assert.equal(fourth.disposition, 'candidate');
  assert.deepEqual(a.loadSnapshot(fourth.latest.path).snapshot.artifacts.question_resolutions, resolvedAgain.question_resolutions);
});

test('human answers bind the exact source question and retain meaning after explicit closure', () => {
  const f = withOpenQuestion();
  const input = [{ question_id: 'Q1', answer: 'Only the operations lead can cancel.' }];
  const configPath = resumeConfig(f, f.first.latest, { answers: input });
  const prepared = a.prepare({ config_path: configPath });
  const expected = [{ ...input[0], question: 'Who can cancel an order?', revision: 1, attribution: 'human' }];
  assert.deepEqual(prepared.snapshot.human_answers, expected);
  const artifacts = closedBundle([resolution({ resolution: input[0].answer, evidence: ['human:Q1:r1'] })]);
  const second = commitRound(prepared, roleOutput('synthesis', { artifacts, disposition: 'candidate' })).committed;
  const projected = a.loadSnapshot(second.latest.path).snapshot;
  assert.deepEqual(projected.human_answers, expected);
  assert.deepEqual(projected.artifacts.open_questions, []);
  assert.equal(projected.artifacts.question_resolutions[0].question, expected[0].question);
  assert.deepEqual(projected.artifacts.question_resolutions[0].evidence, ['human:Q1:r1']);
  assert.deepEqual(readJSON(second.latest.path).human_answers, expected);
  const revision = a.prepare({ config_path: resumeConfig(f, second.latest, {
    answers: [{ question_id: 'Q1', answer: 'Correction: any operations member.' }], name: 'revision.json',
  }) });
  assert.deepEqual(revision.snapshot.human_answers.map((row) => [row.question, row.revision]), [
    ['Who can cancel an order?', 1], ['Who can cancel an order?', 2],
  ]);
});

test('answer input cannot supply its own question wording; CLI preserves the validated resume ref', () => {
  const f = withOpenQuestion();
  const before = readFileSync(f.first.latest.path);
  const config = resumeConfig(f, f.first.latest, { answers: [{ question_id: 'Q1', question: 'A substituted question?', answer: 'Yes' }] });
  const result = cli('prepare', { config_path: config });
  assert.equal(result.status, 1);
  assert.equal(result.packet.error.code, 'E_SCHEMA');
  assert.deepEqual(result.packet.error.latest, f.first.latest);
  assert.deepEqual(readFileSync(f.first.latest.path), before);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

for (const [name, transform] of [
  ['silent question disappearance into candidate', (synthesis) => { synthesis.artifacts = bundle(); synthesis.disposition = 'candidate'; }],
  ['question wording changed under the same ID', (synthesis) => { synthesis.artifacts.open_questions[0].question = 'Who can approve an order?'; }],
]) test(`lineage rejects ${name} even when snapshot and synthesis agree`, () => {
  const f = withOpenQuestion();
  const second = commitRound(f.first, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const forged = tamper(second.latest.path, (stored) => replaceSynthesis(stored, transform));
  // A standalone round cannot know its predecessor's questions; the chain must.
  a.validateSnapshot(forged);
  expectError('E_LINEAGE', () => a.loadSnapshot(second.latest.path));
});

for (const [name, mutate] of [
  ['closure history discarded', (rows) => rows.splice(0)],
  ['historical closure text changed', (rows) => { rows[0].resolution = 'An altered historical decision.'; }],
  ['historical closure evidence changed', (rows) => { rows[0].evidence = ['source:L1']; }],
]) test(`lineage rejects ${name} despite matching artifacts and synthesis`, () => {
  const f = withResolution();
  const third = commitRound(f.second, roleOutput('synthesis', { artifacts: f.closed })).committed;
  const forged = tamper(third.latest.path, (stored) => replaceSynthesis(stored, (synthesis) => mutate(synthesis.artifacts.question_resolutions)));
  a.validateSnapshot(forged);
  expectError('E_LINEAGE', () => a.loadSnapshot(third.latest.path), /history/);
});

for (const [name, mutate, code] of [
  ['human question wording changed', (row) => { row.question = 'Who can approve an order?'; }, 'E_LINEAGE'],
  ['human question ID substituted', (row) => { row.question_id = 'Q2'; }, 'E_INPUT'],
]) test(`lineage rejects ${name} without relying on the caller's latest hash`, () => {
  const f = withOpenQuestion();
  const prepared = a.prepare({ config_path: resumeConfig(f, f.first.latest, { answers: [{ question_id: 'Q1', answer: 'Operations.' }] }) });
  const second = commitRound(prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const forged = tamper(second.latest.path, (stored) => mutate(stored.human_answers[0]));
  a.validateSnapshot(forged);
  expectError(code, () => a.loadSnapshot(second.latest.path));
});

for (const [name, mutate] of [
  ['human answer text rewritten', (answers) => { answers[0].answer = 'Meaning silently changed.'; }],
  ['human answer history removed', (answers) => answers.splice(0)],
]) test(`lineage rejects ${name} in a later otherwise valid snapshot`, () => {
  const f = withOpenQuestion();
  const prepared = a.prepare({ config_path: resumeConfig(f, f.first.latest, { answers: [{ question_id: 'Q1', answer: 'Operations.' }] }) });
  const second = commitRound(prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const third = commitRound(second, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const forged = tamper(third.latest.path, (stored) => mutate(stored.human_answers));
  a.validateSnapshot(forged);
  expectError('E_LINEAGE', () => a.loadSnapshot(third.latest.path), /Human answer history/);
});
