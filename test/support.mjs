import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runWorkflow } from './harness.mjs';
import * as artifacts from '../artifacts.mjs';

// Independent public-contract expectations, not imported implementation tables.
export const SECTION_NAMES = [
  'shared_understanding', 'ubiquitous_language', 'subdomains', 'process_model',
  'rules_and_aggregates', 'bounded_contexts', 'context_map', 'architecture_candidates',
  'stressor_analysis', 'assumptions', 'decisions', 'change_log',
];
export const VOICES = ['journey', 'model', 'stressor'];
export const ROLE_SLOTS = ['agenda', 'explore-journey', 'explore-model', 'explore-stressor',
  'expert', 'challenge-journey', 'challenge-model', 'challenge-stressor', 'synthesis'];
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW = join(ROOT, 'architecture-iteration.js');
export const COMPANION = join(ROOT, 'artifacts.mjs');
export const clone = (value) => structuredClone(value);
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value));

// Deliberately retain all temporary evidence. No cleanup/removal of any file.
export function fixture({ source = 'Orders are accepted.\r\nOperations dispatch orders.\n', config = {}, name = 'architecture-offline-' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const sourcePath = join(directory, 'strategy.md');
  const outputPath = join(directory, 'artifacts');
  const configPath = join(directory, 'start.json');
  writeFileSync(sourcePath, source);
  writeJSON(configPath, { document: 'strategy.md', output: 'artifacts', max_rounds: 1, ...config });
  return { directory, sourcePath, outputPath, configPath };
}
export function prepareFixture(options) {
  const fixtureData = fixture(options);
  return { ...fixtureData, prepared: artifacts.prepare({ config_path: fixtureData.configPath }) };
}
export function event(id = 'E1') {
  return { id, name: 'Order accepted', actor: 'Customer', scenario: 'A customer submits an order',
    evidence: ['source:L1'], confidence: 'grounded' };
}
export function bundle({ question = false, modeled = true, events = true } = {}) {
  const result = Object.fromEntries(SECTION_NAMES.map((name) => [name, {
    status: modeled ? 'modeled' : 'not-modeled',
    content: modeled ? `${name}: bounded example, not stakeholder approval.` : 'Not modeled: more source evidence is needed.',
  }]));
  result.event_flow = { events: events ? [event()] : [], relations: [], hotspots: ['Dispatch timing is unknown.'] };
  result.open_questions = question ? [{ id: 'Q1', question: 'Who can cancel an order?', blocking: true }] : [];
  result.question_resolutions = [];
  return result;
}
export function resolution({ question_id = 'Q1', question = 'Who can cancel an order?',
  resolution = 'Cancellation authority remains with Operations.', evidence = ['source:L2'] } = {}) {
  return { question_id, question, resolution, evidence };
}
export function roleOutput(slot, { artifacts: current = bundle(), disposition = 'continue', marker = 'offline' } = {}) {
  if (slot === 'agenda') return { focus: `Understand orders (${marker})`, stage: 'big-picture', questions: ['Who can cancel?'] };
  if (slot === 'expert') return { answers: [{ question: 'What is accepted?', answer: 'Orders are accepted.', evidence: ['source:L1'], status: 'grounded' }], unresolved: ['Cancellation policy is unknown.'] };
  if (slot === 'synthesis') return { artifacts: current, disposition, rationale: 'Preserve unknown policy; this is a model for human review.' };
  return { voice: slot.slice(slot.indexOf('-') + 1), observations: [`${marker} observation`], proposals: ['Keep a modular monolith candidate.'], questions: ['Who can cancel?'], dissent: ['Timing remains uncertain.'] };
}
export function stageRound(prepared, output = roleOutput('synthesis')) {
  const attempt = artifacts.begin({ latest: prepared.latest, human_answers: prepared.snapshot.human_answers });
  for (const slot of ROLE_SLOTS.slice(0, -1)) artifacts.stage({ attempt: attempt.attempt, slot, output: roleOutput(slot) });
  return { ...attempt, finish: () => artifacts.finish({ attempt: attempt.attempt, output }) };
}
export function commitRound(prepared, output) {
  const staged = stageRound(prepared, output);
  return { ...staged, committed: staged.finish() };
}
export function resumeConfig(f, latest, { answers, max_rounds = 1, name = 'resume.json', attempt, redo } = {}) {
  const configPath = join(f.directory, name);
  const config = { resume: latest.path, max_rounds };
  if (attempt !== undefined) config.attempt = attempt;
  if (redo !== undefined) config.redo = redo;
  if (answers !== undefined) {
    const path = join(f.directory, `${name}.answers.json`);
    writeJSON(path, answers);
    config.answers = path;
  }
  writeJSON(configPath, config);
  return configPath;
}
export function expectError(code, operation, message) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}
export function cli(operation, request = {}, { raw = JSON.stringify(request), cwd = ROOT } = {}) {
  const result = spawnSync(process.execPath, ['--', COMPANION, operation], { input: raw, cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const packet = JSON.parse(result.stdout);
  assert.ok(result.stdout.endsWith('\n'));
  return { ...result, packet };
}
export function snapshots(f) {
  return readdirSync(f.outputPath).filter((name) => /^round-\d+\.json$/.test(name)).sort();
}
export function tamper(path, transform) {
  const value = readJSON(path);
  transform(value);
  chmodSync(path, 0o600); // Only this test's newly created file is made writable.
  writeJSON(path, value);
  return value;
}
export function padJSON(value, targetBytes, select = (x) => x, key = 'rationale') {
  const result = clone(value);
  const node = select(result);
  const missing = targetBytes - jsonBytes(result);
  assert.ok(missing >= 0, `Fixture already exceeds ${targetBytes} bytes`);
  node[key] += 'x'.repeat(missing);
  assert.equal(jsonBytes(result), targetBytes);
  return result;
}
export function operationOf(command) {
  const match = / '(prepare|input|schemas|begin|output-begin|output-chunk|stage|finish|load|recover|inspect)'$/.exec(command);
  return match?.[1] ?? null;
}
export function uploadOutput(attempt, slot, output, { end, raw = JSON.stringify(output) } = {}) {
  const opened = artifacts.dispatch('output-begin', { attempt, slot, length: raw.length });
  const output_ref = { path: opened.path, length: raw.length, tail: null };
  for (let offset = 0; offset < (end ?? raw.length); offset += 4000) {
    const text = raw.slice(offset, Math.min(offset + 4000, end ?? raw.length));
    const part = artifacts.dispatch('output-chunk', { upload: opened.path, offset, text, previous: output_ref.tail });
    assert.equal(part.text, text);
    output_ref.tail = { offset, sha256: part.sha256 };
  }
  return output_ref;
}
export function workflow(f, { args = f.configPath, output, disposition = 'continue', runStub, newStub, initialState, shellResultStub } = {}) {
  return runWorkflow({ file: WORKFLOW, args, cwd: ROOT, initialState,
    newStub: newStub ?? (({ state }) => { state.readonly = false; }),
    runStub: runStub ?? ((_prompt, options) => {
      const phase = options.input.phase;
      const slot = phase === 'agenda' ? 'agenda' : phase === 'answer' ? 'expert' : phase === 'synthesize' ? 'synthesis'
        : `${phase}-${_prompt.slice(_prompt.lastIndexOf('-') + 1)}`;
      const current = typeof output === 'function' ? output(options.input) : output;
      return { output: roleOutput(slot, { ...(current ? { artifacts: current } : {}), disposition, marker: `round-${options.input.round}` }) };
    }), shellResultStub,
  });
}
export function healthy(result, reason = 'round-limit') {
  assert.ifError(result.error);
  assert.equal(result.exit?.reason, reason, result.exit?.diagnostic);
  assert.deepEqual(result.calls.notebook, []);
  assert.deepEqual([...result.pages.keys()], []);
}
export { artifacts };
