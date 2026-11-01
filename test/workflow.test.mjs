import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifacts as a, ROOT, VOICES, SECTION_NAMES, ROLE_SLOTS, clone, hash, readJSON, writeJSON,
  fixture, prepareFixture, bundle, resolution, roleOutput, commitRound, resumeConfig, snapshots,
  workflow, healthy, operationOf, padJSON,
} from './support.mjs';

const expectedTurns = [
  ['master', 'agenda'], ['journey', 'explore'], ['model', 'explore'], ['stressor', 'explore'],
  ['expert', 'answer'], ['journey', 'challenge'], ['model', 'challenge'], ['stressor', 'challenge'], ['master', 'synthesize'],
];
function stubOutput(prompt, options, { synthesis, mutate } = {}) {
  const phase = options.input.phase;
  const slot = phase === 'agenda' ? 'agenda' : phase === 'answer' ? 'expert' : phase === 'synthesize' ? 'synthesis'
    : `${phase}-${prompt.slice(prompt.lastIndexOf('-') + 1)}`;
  const value = slot === 'synthesis' && synthesis ? clone(synthesis) : roleOutput(slot, { marker: `round-${options.input.round}` });
  if (mutate) mutate(value, slot, options);
  return { output: value };
}
function expectPreservedInitial(f, result, round = 0) {
  assert.ifError(result.error);
  assert.equal(result.exit.reason, 'failed', result.exit.diagnostic);
  assert.equal(result.exit.round, round);
  assert.equal(result.exit.latest_snapshot, join(f.outputPath, `round-${String(round).padStart(4, '0')}.json`));
  assert.equal(a.loadSnapshot(result.exit.latest_snapshot).latest.round, round);
  assert.equal(result.calls.notebook.length, 0);
}

for (const entryReadonly of [false, true]) test(`fresh context before every invocation; nine-turn ordering; restore entry readonly=${entryReadonly}`, () => {
  const f = fixture({ config: { max_rounds: 2 } });
  const resets = [];
  const result = workflow(f, { initialState: { readonly: entryReadonly, historySentinel: 'old-entry' },
    newStub: ({ state, calls }) => {
      resets.push(calls.run.length);
      // Simulate both runtime variants: a reset can drop readonly posture.
      state.readonly = false;
      state.historySentinel = `fresh-${calls.new}`;
    },
    runStub: (prompt, options, { calls, state }) => {
      assert.equal(state.readonly, true);
      assert.equal(state.historySentinel, `fresh-${calls.run.length}`);
      return stubOutput(prompt, options);
    },
  });
  healthy(result);
  assert.equal(result.calls.new, 18);
  assert.deepEqual(resets, Array.from({ length: 18 }, (_, index) => index));
  assert.equal(result.calls.run.length, 18);
  assert.equal(result.exit.round, 2);
  assert.equal(result.calls.readonly.at(-1), entryReadonly);
  assert.deepEqual(result.calls.order.filter((x) => ['new', 'run'].includes(x.handle)).map((x) => x.handle), [
    ...Array.from({ length: 18 }, () => ['new', 'run']).flat(),
  ]);
  for (let round = 1; round <= 2; round++) {
    const turns = result.calls.run.slice((round - 1) * 9, round * 9);
    for (const [index, [voice, phase]] of expectedTurns.entries()) {
      const turn = turns[index];
      assert.equal(turn.prompt, `/skill:architecture-iteration-${voice}`);
      assert.equal(turn.options.args, `round-${round} ${phase}`);
      assert.equal(turn.options.input.round, round);
      assert.equal(turn.options.input.phase, phase);
      assert.equal(turn.readonly, true);
      assert.equal(turn.options.output.schema.type, 'object');
      assert.equal(turn.options.output.schema.additionalProperties, false);
      assert.equal(Object.hasOwn(turn.options, 'model'), false, 'Do not hard-code an invented group API');
      const expectedKeys = ['round', 'phase', 'snapshot'];
      if (phase !== 'agenda') expectedKeys.push('agenda');
      if (['answer', 'challenge', 'synthesize'].includes(phase)) expectedKeys.push('proposals');
      if (['challenge', 'synthesize'].includes(phase)) expectedKeys.push('expert');
      if (phase === 'synthesize') expectedKeys.push('challenges');
      assert.deepEqual(Object.keys(turn.options.input).sort(), expectedKeys.sort());
      assert.deepEqual(turn.options.input.snapshot, turns[0].options.input.snapshot);
      if (phase === 'answer' || phase === 'challenge' || phase === 'synthesize') {
        assert.deepEqual(turn.options.input.proposals.map((value) => value.voice), VOICES);
      }
      if (phase === 'challenge') assert.equal(Object.hasOwn(turn.options.input, 'challenges'), false);
      if (phase === 'synthesize') assert.deepEqual(turn.options.input.challenges.map((value) => value.voice), VOICES);
    }
    const stored = readJSON(join(f.outputPath, `round-${String(round).padStart(4, '0')}.json`));
    const projected = turns[0].options.input.snapshot;
    assert.equal(projected.round, round - 1);
    assert.equal(Object.hasOwn(projected, 'role_outputs'), false);
    assert.equal(Object.hasOwn(projected, 'previous'), false);
    assert.deepEqual(projected.source, stored.source);
  }
  assert.deepEqual(result.checkpoints.map((x) => [x.phase, x.round]), [['prepared', 0], ['committed', 1], ['committed', 2]]);
  for (const checkpoint of result.checkpoints) {
    assert.ok(existsSync(checkpoint.latest_snapshot));
    assert.equal(readJSON(checkpoint.latest_snapshot).round, checkpoint.round);
  }
  assert.deepEqual(result.shellCalls.map((x) => operationOf(x.command)).filter((op) => !op?.startsWith('output-')), [
    null, 'prepare', 'schemas', 'input', 'begin', ...Array(8).fill('stage'), 'finish', 'load', 'input', 'begin', ...Array(8).fill('stage'), 'finish',
  ]);
  assert.equal(result.shellCalls.filter((x) => operationOf(x.command) === 'output-begin').length, 18);
  assert.equal(result.shellCalls.filter((x) => operationOf(x.command) === 'output-chunk').length, 18);
  const effects = result.calls.order;
  for (const [index, effect] of effects.entries()) {
    if (effect.handle === 'new') {
      assert.equal(effects[index + 1].handle, 'readonly');
      assert.equal(effects[index + 1].readonly, true);
    }
    if (effect.handle === 'checkpoint' && effect.metadata.phase === 'committed') {
      const before = effects.slice(0, index).findLast((x) => x.handle === 'shell');
      assert.equal(operationOf(before.command), 'finish');
    }
  }
});

test('omitted cap permits exactly three new rounds, not one round per stage', () => {
  const f = fixture();
  writeJSON(f.configPath, { document: 'strategy.md', output: 'artifacts' });
  const result = workflow(f);
  healthy(result);
  assert.equal(result.calls.new, 27);
  assert.equal(result.calls.run.length, 27);
  assert.equal(result.exit.round, 3);
});

test('second round carries full artifact snapshot but never prior role transcripts', () => {
  const f = fixture({ config: { max_rounds: 2 } });
  const result = workflow(f, { runStub: (prompt, options) => {
    const output = stubOutput(prompt, options);
    if (options.input.round === 1 && options.input.phase === 'explore') output.output.observations = ['ROLE_TRANSCRIPT_SENTINEL_ONLY'];
    if (options.input.round === 2) assert.equal(JSON.stringify(options.input.snapshot).includes('ROLE_TRANSCRIPT_SENTINEL_ONLY'), false);
    return output;
  } });
  healthy(result);
  const firstStored = readJSON(join(f.outputPath, 'round-0001.json'));
  assert.match(JSON.stringify(firstStored.role_outputs), /ROLE_TRANSCRIPT_SENTINEL_ONLY/);
  const secondAgenda = result.calls.run[9].options.input.snapshot;
  assert.deepEqual(secondAgenda.artifacts, firstStored.artifacts);
  assert.deepEqual(secondAgenda.human_answers, firstStored.human_answers);
  assert.equal(secondAgenda.rationale, firstStored.rationale);
});

test('resume from explicit file works without source, adds human evidence and preserves older bytes', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const before = readFileSync(first.latest.path);
  const initialBefore = readFileSync(f.prepared.latest.path);
  renameSync(f.sourcePath, join(f.directory, 'retained-source.md'));
  const configPath = resumeConfig(f, first.latest, { answers: [{ question_id: 'Q1', answer: 'Human answer, not simulated consensus.' }], max_rounds: 2 });
  const result = workflow(f, { args: configPath, output: bundle({ question: true }) });
  healthy(result, 'needs-human');
  assert.equal(result.calls.new, 9);
  assert.equal(result.calls.run.length, 9);
  assert.equal(result.exit.round, 2);
  const input = result.calls.run[0].options.input.snapshot;
  assert.equal(input.round, 1);
  assert.equal(input.source.origin, f.sourcePath);
  assert.equal(input.source.sha256, hash(input.source.text));
  assert.deepEqual(input.human_answers, [{ question_id: 'Q1', question: 'Who can cancel an order?', answer: 'Human answer, not simulated consensus.', revision: 1, attribution: 'human' }]);
  assert.deepEqual(readJSON(result.exit.latest_snapshot).human_answers, input.human_answers);
  assert.deepEqual(readFileSync(first.latest.path), before);
  assert.deepEqual(readFileSync(f.prepared.latest.path), initialBefore);
});

for (const disposition of ['continue', 'candidate']) test(`resume cannot silently discard a blocker to claim ${disposition}`, () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const before = readFileSync(first.latest.path);
  const result = workflow(f, { args: resumeConfig(f, first.latest), disposition });
  expectPreservedInitial(f, result, 1);
  assert.equal(result.exit.phase, 'commit');
  assert.match(result.exit.diagnostic, /Q1.*new.*resolution/i);
  assert.equal(result.calls.new, 9);
  assert.equal(result.calls.run.length, 9);
  assert.deepEqual(readFileSync(first.latest.path), before);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

test('resume closes with human evidence and carries the historical answer meaning into a fresh round', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const answer = 'Only the operations lead may cancel.';
  const closed = bundle();
  closed.question_resolutions = [resolution({ resolution: answer, evidence: ['human:Q1:r1'] })];
  const result = workflow(f, { args: resumeConfig(f, first.latest, { answers: [{ question_id: 'Q1', answer }] }),
    output: closed, disposition: 'candidate' });
  healthy(result, 'candidate');
  assert.equal(result.exit.round, 2);
  const expectedAnswers = [{ question_id: 'Q1', question: 'Who can cancel an order?', answer, revision: 1, attribution: 'human' }];
  const stored = readJSON(result.exit.latest_snapshot);
  assert.deepEqual(stored.human_answers, expectedAnswers);
  assert.deepEqual(stored.artifacts, closed);
  const continued = workflow(f, { args: resumeConfig(f, { path: result.exit.latest_snapshot }, { name: 'continue.json' }),
    runStub: (prompt, options) => {
      assert.equal(options.input.snapshot.round, 2);
      assert.deepEqual(options.input.snapshot.human_answers, expectedAnswers);
      assert.deepEqual(options.input.snapshot.artifacts.question_resolutions, closed.question_resolutions);
      assert.equal(Object.hasOwn(options.input.snapshot, 'role_outputs'), false);
      return stubOutput(prompt, options, { synthesis: roleOutput('synthesis', { artifacts: closed }) });
    } });
  healthy(continued);
  assert.equal(continued.calls.new, 9);
  assert.equal(continued.exit.round, 3);
});

for (const entryReadonly of [false, true]) test(`reset failure makes zero model turns and restores readonly=${entryReadonly}`, () => {
  const f = fixture();
  const result = workflow(f, { initialState: { readonly: entryReadonly }, newStub: ({ state }) => {
    state.readonly = false;
    throw new Error('replacement runtime missing');
  } });
  expectPreservedInitial(f, result);
  assert.equal(result.exit.phase, 'reset');
  assert.match(result.exit.diagnostic, /replacement runtime missing/);
  assert.equal(result.calls.new, 1);
  assert.equal(result.calls.run.length, 0);
  assert.equal(result.calls.readonly.at(-1), entryReadonly);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
  assert.deepEqual(result.checkpoints.map((x) => x.phase), ['prepared']);
});

test('later reset failure preserves the previous completed round and stops before another role', () => {
  const f = fixture({ config: { max_rounds: 2 } });
  const result = workflow(f, { newStub: ({ calls, state }) => {
    state.readonly = false;
    if (calls.new === 10) throw new Error('next-round reset failed');
  } });
  expectPreservedInitial(f, result, 1);
  assert.equal(result.calls.run.length, 9);
  assert.equal(result.calls.new, 10);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

for (const [name, resultValue] of [
  ['missing result', null], ['prose only', { text: JSON.stringify(roleOutput('agenda')) }],
  ['JSON text in output', { output: JSON.stringify(roleOutput('agenda')) }],
  ['array output', { output: [] }], ['null output', { output: null }],
  ['malformed object', { output: { focus: 'Incomplete' } }],
]) test(`native structured role validation rejects ${name}`, () => {
  const f = fixture();
  const result = workflow(f, { runStub: () => resultValue, initialState: { readonly: true } });
  expectPreservedInitial(f, result);
  assert.equal(result.calls.run.length, 1);
  assert.equal(result.calls.readonly.at(-1), true);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
});

test('native output wins over contradictory prose text', () => {
  const f = fixture();
  const result = workflow(f, { runStub: (prompt, options) => ({ ...stubOutput(prompt, options), text: 'not JSON, definitely not the result' }) });
  healthy(result);
});

for (const [name, slot, mutate, expectedCalls, message] of [
  ['wrong exploration voice', 'explore-journey', (v) => { v.voice = 'model'; }, 2, /voice/i],
  ['wrong challenge voice', 'challenge-model', (v) => { v.voice = 'journey'; }, 7, /voice/i],
  ['fabricated grounded evidence', 'expert', (v) => { v.answers[0].evidence = ['source:L999']; }, 5, /outside the source/],
  ['grounded answer without evidence', 'expert', (v) => { v.answers[0].evidence = []; }, 5, /reference/],
  ['cyclic synthesis', 'synthesis', (v) => {
    v.artifacts.event_flow.events.push({ ...v.artifacts.event_flow.events[0], id: 'E2' });
    v.artifacts.event_flow.relations = [{ from: 'E1', to: 'E2', kind: 'causes', note: 'Forward' }, { from: 'E2', to: 'E1', kind: 'precedes', note: 'Backward' }];
  }, 9, /cycle/],
  ['full replacement missing section', 'synthesis', (v) => { delete v.artifacts.decisions; }, 9, /required/],
]) test(`workflow rejects ${name} without an incomplete committed round`, () => {
  const f = fixture();
  const result = workflow(f, { runStub: (prompt, options) => stubOutput(prompt, options, { mutate: (v, current) => {
    if (current === slot) mutate(v);
  } }) });
  expectPreservedInitial(f, result);
  assert.equal(result.calls.run.length, expectedCalls);
  assert.match(result.exit.diagnostic, message);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
});

test('model exception is reported and previous durable snapshot remains resumable', () => {
  const f = fixture();
  const failed = workflow(f, { runStub: () => { throw new Error('provider stub failed'); } });
  expectPreservedInitial(f, failed);
  assert.match(failed.exit.diagnostic, /provider stub failed/);
  const prior = readFileSync(failed.exit.latest_snapshot);
  const resumed = workflow(f, { args: resumeConfig(f, { path: failed.exit.latest_snapshot }) });
  healthy(resumed);
  assert.equal(resumed.exit.round, 1);
  assert.deepEqual(readFileSync(failed.exit.latest_snapshot), prior);
});

for (const [name, value, expectedReason] of [
  ['blocking questions', roleOutput('synthesis', { artifacts: bundle({ question: true }), disposition: 'candidate' }), 'needs-human'],
  ['complete candidate', roleOutput('synthesis', { disposition: 'candidate' }), 'candidate'],
  ['candidate missing events', roleOutput('synthesis', { artifacts: bundle({ events: false }), disposition: 'candidate' }), 'round-limit'],
  ['candidate missing modeling', roleOutput('synthesis', { artifacts: bundle({ modeled: false }), disposition: 'candidate' }), 'round-limit'],
]) test(`workflow disposition gate: ${name}`, () => {
  const f = fixture({ config: { max_rounds: 1 } });
  const result = workflow(f, { runStub: (prompt, options) => stubOutput(prompt, options, { synthesis: value }) });
  healthy(result, expectedReason);
  assert.equal(result.calls.run.length, 9);
  const stored = readJSON(result.exit.latest_snapshot);
  assert.equal(stored.disposition, expectedReason === 'round-limit' ? 'continue' : expectedReason);
  assert.equal(stored.role_outputs.synthesis.disposition, value.disposition);
});

test('full synthesis can exceed 6 KiB and commits a 20 KiB artifact bundle', () => {
  const f = fixture();
  const large = padJSON(bundle(), 20 * 1024, (v) => v.shared_understanding, 'content');
  const result = workflow(f, { output: large });
  healthy(result);
  assert.deepEqual(readJSON(result.exit.latest_snapshot).artifacts, large);
});

test('exact 24 KiB synthesis survives orchestration, commit and stored snapshot validation', () => {
  const f = fixture();
  const value = padJSON(roleOutput('synthesis'), 24 * 1024);
  const result = workflow(f, { runStub: (prompt, options) => stubOutput(prompt, options, { synthesis: value }) });
  healthy(result);
  assert.deepEqual(readJSON(result.exit.latest_snapshot).role_outputs.synthesis, value);
  assert.equal(a.loadSnapshot(result.exit.latest_snapshot).latest.round, 1);
});

for (const [name, slot, value] of [
  ['normal response exceeds former 6 KiB cap', 'agenda', padJSON(roleOutput('agenda'), 6 * 1024 + 1, (v) => v, 'focus')],
  ['synthesis exceeds former 24 KiB cap', 'synthesis', padJSON(roleOutput('synthesis'), 24 * 1024 + 1)],
  ['artifact bundle exceeds former 20 KiB cap', 'synthesis', roleOutput('synthesis', { artifacts: padJSON(bundle(), 20 * 1024 + 1, (v) => v.shared_understanding, 'content') })],
]) test(`workflow accepts ${name}`, () => {
  const f = fixture();
  const result = workflow(f, { runStub: (prompt, options) => {
    if (options.input.phase === (slot === 'agenda' ? 'agenda' : 'synthesize')) return { output: value };
    return stubOutput(prompt, options);
  } });
  healthy(result);
  assert.equal(result.calls.run.length, 9);
  const stored = readJSON(result.exit.latest_snapshot);
  assert.deepEqual(slot === 'agenda' ? stored.role_outputs.agenda : stored.role_outputs.synthesis, value);
});

for (const args of ['', ' ', '\n', 'config\nother.json', 'invalid\0path']) test(`invalid path argument ${JSON.stringify(args)} exits before effects`, () => {
  const f = fixture();
  const result = workflow(f, { args, initialState: { readonly: true } });
  assert.ifError(result.error);
  assert.equal(result.exit.reason, 'needs-input');
  assert.equal(result.exit.latest_snapshot, null);
  assert.equal(result.calls.shell.length, 0);
  assert.equal(result.calls.run.length, 0);
  assert.equal(result.calls.new, 0);
  assert.equal(existsSync(f.outputPath), false);
});

test('invalid configuration stops before reset or model turns', () => {
  for (const mutate of [
    (f) => writeJSON(f.configPath, { document: 'strategy.md', output: 'artifacts', max_rounds: 9 }),
    (f) => writeFileSync(f.configPath, 'not JSON'),
  ]) {
    const f = fixture();
    mutate(f);
    const result = workflow(f);
    assert.ifError(result.error);
    assert.equal(result.exit.reason, 'needs-input');
    assert.equal(result.calls.run.length, 0);
    assert.equal(result.calls.new, 0);
    assert.equal(result.calls.readonly.at(-1), false);
    assert.equal(existsSync(f.outputPath), false);
  }
});

test('invalid human input never creates another snapshot or invokes a model', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const prior = readFileSync(first.latest.path);
  const config = resumeConfig(f, first.latest, { answers: [{ question_id: 'UNKNOWN', answer: 'Invalid' }] });
  const result = workflow(f, { args: config });
  assert.ifError(result.error);
  assert.equal(result.exit.reason, 'needs-input');
  assert.equal(result.exit.round, first.latest.round);
  assert.equal(result.exit.latest_snapshot, first.latest.path);
  assert.equal(result.calls.run.length, 0);
  assert.equal(result.calls.new, 0);
  assert.deepEqual(result.shellCalls.map((x) => operationOf(x.command)), [null, 'prepare']);
  assert.deepEqual(readFileSync(first.latest.path), prior);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

for (const [name, corrupt] of [
  ['truncated', (r) => ({ ...r, truncated: true })],
  ['killed', (r) => ({ ...r, killed: true })],
  ['failed exit', (r) => ({ ...r, ok: false, exitCode: 17 })],
  ['malformed JSON', (r) => ({ ...r, output: 'not JSON' })],
  ['missing output', (r) => ({ ...r, output: undefined })],
  ['oversize UTF-8 output', (r) => ({ ...r, output: 'é'.repeat(23 * 1024) })],
  ['non-object packet', (r) => ({ ...r, output: '[]' })],
  ['extra success key', (r) => ({ ...r, output: JSON.stringify({ ...JSON.parse(r.output), untrusted: true }) })],
]) test(`prepare transport ${name}: recover initial durable snapshot; zero turns`, () => {
  const f = fixture();
  const result = workflow(f, { shellResultStub: (reply, command) => operationOf(command) === 'prepare' ? corrupt(reply) : reply });
  expectPreservedInitial(f, result);
  assert.equal(result.calls.new, 0);
  assert.equal(result.calls.run.length, 0);
  assert.deepEqual(result.shellCalls.map((x) => operationOf(x.command)), [null, 'prepare', 'inspect']);
});

for (const operation of ['schemas', 'begin', 'stage']) test(`${operation} transport truncation preserves previous snapshot and stops promptly`, () => {
  const f = fixture();
  let injected = false;
  const result = workflow(f, { shellResultStub: (reply, command) => {
    if (!injected && operationOf(command) === operation) { injected = true; return { ...reply, truncated: true }; }
    return reply;
  } });
  expectPreservedInitial(f, result);
  assert.equal(injected, true);
  assert.equal(result.calls.run.length, operation === 'stage' ? 1 : 0);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
  assert.equal(result.checkpoints.filter((x) => x.phase === 'committed').length, 0);
});

for (const [name, corrupt] of [
  ['truncated', (r) => ({ ...r, truncated: true })],
  ['killed', (r) => ({ ...r, killed: true })],
  ['failed exit', (r) => ({ ...r, ok: false, exitCode: 2 })],
  ['malformed JSON', (r) => ({ ...r, output: '{broken' })],
  ['wrong round acknowledgement', (r) => { const p = JSON.parse(r.output); p.data.latest.round += 1; return { ...r, output: JSON.stringify(p) }; }],
]) test(`finish transport ${name} recovers the committed round rather than claiming an incomplete draft`, () => {
  const f = fixture();
  let initialRaw;
  const result = workflow(f, { shellResultStub: (reply, command) => {
    if (operationOf(command) === 'prepare') initialRaw = readFileSync(join(f.outputPath, 'round-0000.json'));
    return operationOf(command) === 'finish' ? corrupt(reply) : reply;
  } });
  expectPreservedInitial(f, result, 1);
  assert.equal(result.exit.phase, 'commit');
  assert.equal(result.calls.run.length, 9);
  assert.equal(operationOf(result.shellCalls.at(-1).command), 'recover');
  assert.deepEqual(readFileSync(join(f.outputPath, 'round-0000.json')), initialRaw);
  assert.deepEqual(result.checkpoints.map((x) => x.phase), ['prepared']);
});

test('failed commit-reply recovery retains last confirmed ref and preserves actual committed evidence', () => {
  const f = fixture();
  const result = workflow(f, { shellResultStub: (reply, command) => ['finish', 'recover'].includes(operationOf(command)) ? { ...reply, killed: true } : reply });
  assert.ifError(result.error);
  assert.equal(result.exit.reason, 'failed');
  assert.equal(result.exit.round, 0);
  assert.equal(result.exit.latest_snapshot, join(f.outputPath, 'round-0000.json'));
  assert.equal(a.loadSnapshot(join(f.outputPath, 'round-0001.json')).latest.round, 1);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

test('escaped source plus larger artifacts loads across packets without loss or hidden truncation', () => {
  const f = fixture({ source: '\u0001'.repeat(6000), config: { max_rounds: 2 } });
  const large = padJSON(bundle(), 20 * 1024, (v) => v.shared_understanding, 'content');
  const result = workflow(f, { output: large });
  assert.ifError(result.error);
  healthy(result);
  assert.equal(result.exit.round, 2);
  assert.equal(result.calls.new, 18);
  assert.equal(result.calls.run.length, 18);
  const committed = readJSON(result.exit.latest_snapshot);
  assert.deepEqual(committed.artifacts, large);
  assert.equal(committed.source.text, '\u0001'.repeat(6000));
  assert.equal(committed.source.sha256, hash(committed.source.text));
  a.validateSnapshot(committed);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json', 'round-0002.json']);
});

test('load truncation after first round preserves committed round and does not reset again', () => {
  const f = fixture({ config: { max_rounds: 2 } });
  const result = workflow(f, { shellResultStub: (reply, command) => operationOf(command) === 'load' ? { ...reply, truncated: true } : reply });
  expectPreservedInitial(f, result, 1);
  assert.equal(result.exit.phase, 'load');
  assert.equal(result.calls.new, 9);
  assert.equal(result.calls.run.length, 9);
  assert.equal(result.checkpoints.at(-1).round, 1);
});

for (const [name, operation, mutate] of [
  ['bad reference', 'prepare', (p) => { p.data.latest.sha256 = 'not-a-hash'; }],
  ['bad input descriptor', 'prepare', (p) => { p.data.input_ref.length = -1; }],
  ['bad cap', 'prepare', (p) => { p.data.max_rounds = 9; }],
  ['bad schema', 'schemas', (p) => { p.data.agenda = null; }],
  ['bad attempt round', 'begin', (p) => { p.data.round = 7; }],
  ['wrong stage slot', 'stage', (p) => { p.data.slot = 'expert'; }],
  ['wrong stage round', 'stage', (p) => { p.data.round = 7; }],
]) test(`malformed companion acknowledgement: ${name}`, () => {
  const f = fixture();
  const result = workflow(f, { shellResultStub: (reply, command) => {
    if (operationOf(command) !== operation) return reply;
    const packet = JSON.parse(reply.output);
    mutate(packet);
    return { ...reply, output: JSON.stringify(packet) };
  } });
  expectPreservedInitial(f, result);
  assert.equal(result.calls.run.length, operation === 'stage' ? 1 : 0);
});

test('stale resume fails before reset, keeps all committed evidence and returns latest durable ref', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared).committed;
  const before = readFileSync(first.latest.path);
  const config = resumeConfig(f, f.prepared.latest);
  const result = workflow(f, { args: config });
  expectPreservedInitial(f, result, 1);
  assert.match(result.exit.diagnostic, /Stale resume/);
  assert.equal(result.calls.new, 0);
  assert.equal(result.calls.run.length, 0);
  assert.deepEqual(readFileSync(first.latest.path), before);
});

test('quoted paths, spaces, apostrophes and shell substitutions stay inert in config and role data', () => {
  const f = fixture();
  const directory = join(f.directory, 'inputs with spaces \' " $(printf injected) `printf nope`');
  mkdirSync(directory);
  const document = 'strategy \' " $(printf source).md';
  const output = 'artifacts \' " $(printf output)';
  const config = join(directory, 'config \' " $(printf config).json');
  writeFileSync(join(directory, document), 'Orders are accepted.\n');
  writeJSON(config, { document, output, max_rounds: 1 });
  const marker = join(f.directory, 'must-not-be-created');
  const value = bundle();
  const hostile = `literal quote '\n\"; $(touch ${marker}) \`touch ${marker}\` $HOME \\ EOF\n`;
  for (const name of SECTION_NAMES) value[name].content += hostile;
  for (const quote of ['"', "'"]) {
    // Each invocation has a distinct output directory; evidence is never reused/overwritten.
    const configValue = readJSON(config);
    configValue.output += quote === '"' ? '-double' : '-single';
    writeJSON(config, configValue);
    const result = workflow(f, { args: quote + config + quote, output: value });
    healthy(result);
    assert.deepEqual(readJSON(result.exit.latest_snapshot).artifacts, value);
    assert.equal(readJSON(result.exit.latest_snapshot).source.origin, join(directory, document));
    assert.equal(existsSync(marker), false);
  }
  assert.ok(existsSync(join(ROOT, 'architecture-iteration.js')));
  assert.ok(existsSync(join(ROOT, 'artifacts.mjs')));
});
