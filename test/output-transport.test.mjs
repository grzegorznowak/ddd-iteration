import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifacts as a, ROLE_SLOTS, fixture, prepareFixture, roleOutput, bundle, workflow, healthy,
  operationOf, readJSON, hash, snapshots, uploadOutput, expectError, tamper, cli, stageRound,
} from './support.mjs';

function largeOutput(slot) {
  const value = roleOutput(slot);
  // Include controls, quoting, astral and lone surrogate characters. A valid
  // surrogate pair is deliberately split across a 4,000-code-unit wire boundary.
  const content = '\u0001\r\n😀é\ud800\\\"\' literal $(printf no) '.repeat(2400);
  if (slot === 'agenda') value.focus = 'x'.repeat(3989) + '😀' + content;
  else if (slot === 'expert') value.answers[0].answer = content;
  else if (slot === 'synthesis') {
    value.artifacts.shared_understanding.content = content;
    value.rationale = content;
  } else value.observations = [content];
  return value;
}

test('all nine large native outputs persist exactly through bounded packets and two rounds', () => {
  const f = fixture({ config: { max_rounds: 2 } });
  const expected = new Map();
  const replies = [];
  const result = workflow(f, { shellResultStub: (reply) => { replies.push(reply); return reply; }, runStub: (prompt, options) => {
    const phase = options.input.phase;
    const slot = phase === 'agenda' ? 'agenda' : phase === 'answer' ? 'expert' : phase === 'synthesize' ? 'synthesis'
      : `${phase}-${prompt.slice(prompt.lastIndexOf('-') + 1)}`;
    const output = largeOutput(slot);
    expected.set(slot, output);
    if (options.input.round === 2) assert.deepEqual(options.input.snapshot.artifacts, largeOutput('synthesis').artifacts);
    return { output, text: 'Prose must never replace native output.' };
  } });
  healthy(result);
  assert.equal(result.calls.run.length, 18);
  assert.equal(result.exit.round, 2);
  const stored = readJSON(result.exit.latest_snapshot);
  assert.deepEqual(stored.role_outputs.agenda, expected.get('agenda'));
  assert.deepEqual(stored.role_outputs.expert, expected.get('expert'));
  assert.deepEqual(stored.role_outputs.synthesis, expected.get('synthesis'));
  for (const [index, voice] of ['journey', 'model', 'stressor'].entries()) {
    assert.deepEqual(stored.role_outputs.proposals[index], expected.get(`explore-${voice}`));
    assert.deepEqual(stored.role_outputs.challenges[index], expected.get(`challenge-${voice}`));
  }
  assert.deepEqual(stored.artifacts, expected.get('synthesis').artifacts);
  assert.equal(stored.rationale, expected.get('synthesis').rationale);
  assert.ok(readFileSync(result.exit.latest_snapshot).length > 128 * 1024);
  assert.equal(a.loadSnapshot(result.exit.latest_snapshot).latest.sha256, hash(readFileSync(result.exit.latest_snapshot)));
  for (const call of result.shellCalls) {
    assert.ok(Buffer.byteLength(call.command) < 45 * 1024);
    if (['stage', 'finish'].includes(operationOf(call.command))) {
      assert.match(call.command, /output_ref/);
      assert.ok(Buffer.byteLength(call.command) < 2048);
    }
  }
  for (const reply of replies) assert.ok(Buffer.byteLength(reply.output) < 45 * 1024);
});

test('chunked CLI finish/recover keep a large rationale out of bounded metadata', () => {
  const f = prepareFixture();
  const attempted = stageRound(f.prepared);
  const output = largeOutput('synthesis');
  const output_ref = uploadOutput(attempted.attempt, 'synthesis', output);
  const finished = cli('finish', { attempt: attempted.attempt, output_ref });
  assert.equal(finished.status, 0);
  assert.deepEqual(Object.keys(finished.packet.data).sort(), ['disposition', 'latest']);
  assert.equal(readJSON(finished.packet.data.latest.path).rationale, output.rationale);
  const recovered = cli('recover', { attempt: attempted.attempt });
  assert.equal(recovered.status, 0);
  assert.deepEqual(recovered.packet.data, finished.packet.data);
  assert.ok(Buffer.byteLength(finished.stdout) < 2048);
});

for (const [name, mutate] of [
  ['truncated', (reply) => ({ ...reply, truncated: true })],
  ['killed', (reply) => ({ ...reply, killed: true })],
  ['failed', (reply) => ({ ...reply, ok: false, exitCode: 2 })],
  ['malformed', (reply) => ({ ...reply, output: '{broken' })],
  ['wrong text', (reply) => change(reply, (p) => { p.text += 'changed'; })],
  ['wrong offset', (reply) => change(reply, (p) => { p.offset++; })],
  ['wrong next', (reply) => change(reply, (p) => { p.next++; })],
  ['wrong total', (reply) => change(reply, (p) => { p.length++; })],
  ['wrong upload', (reply) => change(reply, (p) => { p.upload += 'changed'; })],
  ['wrong predecessor', (reply) => change(reply, (p) => { p.previous = { offset: 0, sha256: '0'.repeat(64) }; })],
  ['bad hash', (reply) => change(reply, (p) => { p.sha256 = 'bad'; })],
  ['changed hash', (reply) => change(reply, (p) => { p.sha256 = '0'.repeat(64); })],
]) test(`output packet ${name} stops before a role is published`, () => {
  const f = fixture();
  const result = workflow(f, { runStub: () => ({ output: largeOutput('agenda') }),
    shellResultStub: (reply, command) => operationOf(command) === 'output-chunk' ? mutate(reply) : reply });
  assert.equal(result.exit.reason, 'failed');
  assert.equal(result.exit.round, 0);
  assert.equal(result.calls.run.length, 1);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
  const attempt = readdirSync(f.outputPath).find((p) => p.startsWith('.attempt-'));
  assert.equal(existsSync(join(f.outputPath, attempt, 'role-agenda.json')), false);
});
function change(reply, mutate) {
  const packet = JSON.parse(reply.output);
  mutate(packet.data);
  return { ...reply, output: JSON.stringify(packet) };
}

for (const [name, mutate] of [
  ['slot', (p) => { p.slot = 'expert'; }], ['attempt', (p) => { p.attempt += '-wrong'; }],
  ['length', (p) => { p.length++; }], ['path', (p) => { p.path += '/other'; }],
]) test(`output-begin rejects wrong ${name} binding`, () => {
  const f = fixture();
  const result = workflow(f, { shellResultStub: (reply, command) => operationOf(command) === 'output-begin' ? change(reply, mutate) : reply });
  assert.equal(result.exit.reason, 'failed');
  assert.equal(result.exit.round, 0);
  assert.equal(result.calls.run.length, 1);
});

for (const failure of ['incomplete', 'bad tail', 'changed chunk', 'wrong length', 'wrong slot', 'wrong attempt', 'empty']) {
  test(`stage rejects ${failure} upload and retains prior snapshot`, () => {
    const f = prepareFixture();
    const { attempt } = a.begin({ latest: f.prepared.latest, human_answers: [] });
    const value = largeOutput('agenda');
    const output_ref = uploadOutput(attempt, 'agenda', value, failure === 'incomplete' ? { end: 4000 } : {});
    let target = attempt;
    if (failure === 'bad tail') output_ref.tail.sha256 = '0'.repeat(64);
    if (failure === 'changed chunk') tamper(join(output_ref.path, 'chunk-0.json'), (p) => { p.text += 'changed'; });
    if (failure === 'wrong length') output_ref.length++;
    if (failure === 'wrong slot') tamper(join(output_ref.path, 'output.json'), (p) => { p.slot = 'expert'; });
    if (failure === 'wrong attempt') target = a.begin({ latest: f.prepared.latest, human_answers: [] }).attempt;
    if (failure === 'empty') output_ref.tail = null;
    expectError('E_LINEAGE', () => a.stage({ attempt: target, slot: 'agenda', output_ref }));
    assert.equal(existsSync(join(target, 'role-agenda.json')), false);
    assert.deepEqual(snapshots(f), ['round-0000.json']);
  });
}

test('output chunks reject duplicate, skipped and oversize writes without overwrite', () => {
  const f = prepareFixture();
  const { attempt } = a.begin({ latest: f.prepared.latest, human_answers: [] });
  const upload = a.outputBegin({ attempt, slot: 'agenda', length: 10000 });
  const first = a.outputChunk({ upload: upload.path, offset: 0, text: 'x'.repeat(4000), previous: null });
  const path = join(upload.path, 'chunk-0.json');
  const before = readFileSync(path);
  assert.equal(statSync(path).mode & 0o222, 0);
  assert.throws(() => a.outputChunk({ upload: upload.path, offset: 0, text: 'y', previous: null }), { code: 'EEXIST' });
  expectError('E_LINEAGE', () => a.outputChunk({ upload: upload.path, offset: 5000, text: 'x', previous: { offset: 0, sha256: first.sha256 } }));
  expectError('E_INPUT', () => a.outputChunk({ upload: upload.path, offset: 4000, text: 'x'.repeat(4001), previous: { offset: 0, sha256: first.sha256 } }));
  assert.deepEqual(readFileSync(path), before);
});

for (const raw of ['{"focus":"x",', '{"focus":"x","focus":"y","stage":"design","questions":[]}', JSON.stringify(roleOutput('agenda'), null, 2)]) {
  test(`stage rejects incomplete/nonexact JSON: ${raw.slice(0, 24)}`, () => {
    const f = prepareFixture();
    const { attempt } = a.begin({ latest: f.prepared.latest, human_answers: [] });
    const output_ref = uploadOutput(attempt, 'agenda', null, { raw });
    assert.throws(() => a.stage({ attempt, slot: 'agenda', output_ref }), (error) => ['E_INPUT', 'E_LINEAGE'].includes(error.code));
    assert.equal(existsSync(join(attempt, 'role-agenda.json')), false);
  });
}

test('large output still requires valid schema/evidence/DAG, not just transport integrity', () => {
  const f = prepareFixture();
  const { attempt } = a.begin({ latest: f.prepared.latest, human_answers: [] });
  const invalid = largeOutput('agenda');
  invalid.extra = 'not allowed';
  const output_ref = uploadOutput(attempt, 'agenda', invalid);
  expectError('E_SCHEMA', () => a.stage({ attempt, slot: 'agenda', output_ref }));
  assert.equal(existsSync(join(attempt, 'role-agenda.json')), false);
});

test('large synthesis lost finish reply recovers exact committed output', () => {
  const f = fixture();
  const value = largeOutput('synthesis');
  const result = workflow(f, { output: value.artifacts, runStub: (prompt, options) => {
    const phase = options.input.phase;
    const slot = phase === 'agenda' ? 'agenda' : phase === 'answer' ? 'expert' : phase === 'synthesize' ? 'synthesis'
      : `${phase}-${prompt.slice(prompt.lastIndexOf('-') + 1)}`;
    return { output: slot === 'synthesis' ? value : roleOutput(slot) };
  }, shellResultStub: (reply, command) => operationOf(command) === 'finish' ? { ...reply, truncated: true } : reply });
  assert.equal(result.exit.reason, 'failed');
  assert.equal(result.exit.round, 1);
  assert.deepEqual(readJSON(result.exit.latest_snapshot).role_outputs.synthesis, value);
  assert.equal(a.loadSnapshot(result.exit.latest_snapshot).latest.round, 1);
});
