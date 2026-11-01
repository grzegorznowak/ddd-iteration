import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ROOT, artifacts as a, fixture, prepareFixture, cli, workflow, healthy, operationOf,
  hash, readJSON, commitRound, roleOutput, bundle, resumeConfig, tamper,
} from './support.mjs';

function collect(input_ref) {
  const parts = [];
  let offset = 0;
  while (offset < input_ref.length) {
    const result = cli('input', { input_ref, offset });
    assert.equal(result.status, 0);
    assert.ok(Buffer.byteLength(result.stdout) < 45 * 1024);
    const part = result.packet.data;
    assert.equal(part.offset, offset);
    assert.equal(part.sha256, input_ref.sha256);
    assert.equal(part.length, input_ref.length);
    assert.equal(part.next, offset + part.text.length);
    parts.push(part.text);
    offset = part.next;
  }
  const raw = parts.join('');
  assert.equal(hash(raw), input_ref.sha256);
  return JSON.parse(raw);
}

test('large escaped Unicode input crosses bounded packets without loss, then commits above the former snapshot cap', () => {
  const source = '\uFEFF\u0001\r\n😀é'.repeat(20000);
  const f = fixture({ source });
  writeFileSync(f.configPath, JSON.stringify({ document: 'strategy.md', output: 'artifacts', max_rounds: 2 }) + ' '.repeat(100000));
  const result = workflow(f);
  healthy(result);
  assert.equal(result.calls.run.length, 18);
  assert.ok(result.shellCalls.filter(({ command }) => operationOf(command) === 'input').length > 2);
  for (const turn of result.calls.run) {
    assert.equal(turn.options.input.snapshot.source.text, source);
    assert.equal(turn.options.input.snapshot.source.sha256, hash(source));
  }
  const stored = readJSON(result.exit.latest_snapshot);
  assert.equal(stored.source.text, source);
  assert.ok(readFileSync(result.exit.latest_snapshot).length > 128 * 1024);
  assert.equal(a.loadSnapshot(result.exit.latest_snapshot).snapshot.source.text, source);
  for (const { command } of result.shellCalls) assert.ok(Buffer.byteLength(command) < 45 * 1024);
});

test('prepare/load stdout contains only metadata; packets reassemble exact input and detect replacement', () => {
  const f = fixture({ source: '\u0001😀\r\n'.repeat(10000) });
  const prepared = cli('prepare', { config_path: f.configPath });
  assert.equal(prepared.status, 0);
  assert.equal(Object.hasOwn(prepared.packet.data, 'snapshot'), false);
  const first = collect(prepared.packet.data.input_ref);
  assert.equal(first.source.text, readFileSync(f.sourcePath, 'utf8'));
  const loaded = cli('load', { latest: prepared.packet.data.latest });
  assert.deepEqual(collect(loaded.packet.data.input_ref), first);
  const bad = cli('input', { input_ref: { ...loaded.packet.data.input_ref, sha256: '0'.repeat(64) }, offset: 0 });
  assert.equal(bad.packet.error.code, 'E_LINEAGE');
  tamper(loaded.packet.data.input_ref.path, (input) => { input.source.text += 'changed'; });
  assert.equal(cli('input', { input_ref: loaded.packet.data.input_ref, offset: 0 }).packet.error.code, 'E_LINEAGE');
});

test('large cumulative human revisions never travel in begin stdin and remain exact after resume/commit', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const answer = '😀\u0001 Exact human answer.\r\n'.repeat(10000);
  const config = resumeConfig(f, first.latest, { answers: [{ question_id: 'Q1', answer }] });
  const result = workflow(f, { args: config, output: bundle({ question: true }) });
  healthy(result, 'needs-human');
  assert.equal(result.calls.run[0].options.input.snapshot.human_answers[0].answer, answer);
  assert.equal(readJSON(result.exit.latest_snapshot).human_answers[0].answer, answer);
  const next = workflow(f, { args: resumeConfig(f, { path: result.exit.latest_snapshot }, {
    answers: [{ question_id: 'Q1', answer: 'Second revision. ' + answer }], name: 'second-resume.json',
  }), output: bundle({ question: true }) });
  healthy(next, 'needs-human');
  assert.deepEqual(readJSON(next.exit.latest_snapshot).human_answers.map((row) => row.answer), [answer, 'Second revision. ' + answer]);
  for (const result of [next]) {
    const begin = result.shellCalls.find(({ command }) => operationOf(command) === 'begin').command;
    assert.ok(begin.includes('input_ref'));
    assert.equal(begin.includes('human_answers'), false);
    assert.ok(Buffer.byteLength(begin) < 2048);
  }
});

for (const [name, corrupt] of [
  ['truncated', (reply) => ({ ...reply, truncated: true })],
  ['empty', (reply) => { const p = JSON.parse(reply.output); p.data.text = ''; return { ...reply, output: JSON.stringify(p) }; }],
  ['wrong offset', (reply) => { const p = JSON.parse(reply.output); p.data.offset++; return { ...reply, output: JSON.stringify(p) }; }],
  ['wrong hash', (reply) => { const p = JSON.parse(reply.output); p.data.sha256 = '0'.repeat(64); return { ...reply, output: JSON.stringify(p) }; }],
  ['wrong total', (reply) => { const p = JSON.parse(reply.output); p.data.length++; return { ...reply, output: JSON.stringify(p) }; }],
]) test(`input packet ${name} fails before any model call and preserves round zero`, () => {
  const f = fixture();
  const result = workflow(f, { shellResultStub: (reply, command) => operationOf(command) === 'input' ? corrupt(reply) : reply });
  assert.equal(result.exit.reason, 'failed');
  assert.equal(result.exit.phase, 'input');
  assert.equal(result.calls.run.length, 0);
  assert.equal(a.loadSnapshot(result.exit.latest_snapshot).latest.round, 0);
});

const strategicPath = process.env.STRATEGIC_DDD_FIXTURE || resolve(ROOT, '../research_findings/trading-agent-architecture/strategic-ddd.md');
test('unmodified full strategic-ddd.md passes two offline rounds and retains exact bytes/hash', { skip: !existsSync(strategicPath) }, () => {
  const raw = readFileSync(strategicPath);
  const before = hash(raw);
  assert.ok(raw.length > 12 * 1024);
  const f = fixture({ source: raw, config: { max_rounds: 2 } });
  const result = workflow(f);
  healthy(result);
  assert.equal(result.calls.run.length, 18);
  for (const turn of result.calls.run) {
    assert.deepEqual(Buffer.from(turn.options.input.snapshot.source.text), raw);
    assert.equal(turn.options.input.snapshot.source.sha256, before);
  }
  assert.deepEqual(Buffer.from(readJSON(result.exit.latest_snapshot).source.text), raw);
  assert.equal(hash(readFileSync(strategicPath)), before);
});
