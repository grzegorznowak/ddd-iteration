import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { runWorkflow } from './harness.mjs';
import { COMPANION, WORKFLOW, fixture, healthy, operationOf, readJSON, roleOutput, snapshots, writeJSON } from './support.mjs';

const installedName = '.pi/workflows/architecture-iteration.js';
const packageName = 'workflows/architecture-iteration';

// These tests build only the installer's fixed symlink interface. Installer
// behavior/discovery has separate tests. No provider, Pi session, or skill loader
// runs here; the real companion executes with deterministic role outputs.
function linkProject(f, source = WORKFLOW) {
  const link = join(f.directory, installedName);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), source), link);
  return link;
}
function packageFixture(f, name = 'canonical package', { helper = true } = {}) {
  const directory = join(f.directory, name);
  mkdirSync(directory, { recursive: true });
  const source = join(directory, 'architecture-iteration.js');
  // Disposable byte-identical fixtures exercise broken/moved package locations.
  // Installation itself never copies or generates a workflow or companion.
  copyFileSync(WORKFLOW, source);
  if (helper) copyFileSync(COMPANION, join(directory, 'artifacts.mjs'));
  return source;
}
function deterministicRole(prompt, options, { state }) {
  assert.equal(state.readonly, true);
  const { phase } = options.input;
  const slot = phase === 'agenda' ? 'agenda' : phase === 'answer' ? 'expert' : phase === 'synthesize' ? 'synthesis'
    : `${phase}-${prompt.slice(prompt.lastIndexOf('-') + 1)}`;
  return { output: roleOutput(slot, { marker: `foreign-round-${options.input.round}` }) };
}
function installedRound(f, { file = join(f.directory, installedName), cwd = f.directory, ...options } = {}) {
  return runWorkflow({ file, cwd, args: 'start.json', initialState: { readonly: true },
    newStub: ({ state }) => { state.readonly = false; }, runStub: deterministicRole, ...options });
}
function failedBeforeWrites(f, result, message) {
  assert.ifError(result.error);
  assert.equal(result.exit.reason, 'failed', result.exit.diagnostic);
  assert.equal(result.exit.phase, 'resolve');
  assert.equal(result.exit.latest_snapshot, null);
  assert.equal(result.exit.round, null);
  if (message) assert.match(result.exit.diagnostic, message);
  assert.equal(result.calls.run.length, 0);
  assert.equal(result.calls.new, 0);
  assert.equal(result.calls.shell.length, 1, 'Never prepare, inspect, or recover after resolver failure.');
  assert.equal(result.calls.readonly.at(-1), true);
  assert.equal(existsSync(f.outputPath), false);
  assert.deepEqual(result.checkpoints, []);
}

test('foreign project symlink runs real helper for two fresh deterministic rounds', () => {
  const f = fixture({ name: 'architecture-installed-', config: { max_rounds: 2 } });
  const installed = linkProject(f);
  const before = readFileSync(WORKFLOW);
  // A cwd-relative decoy companion must never run. Only the canonical sibling is
  // used. The decoy is not a workflow, so there is no competing source binding.
  const decoy = join(f.directory, packageName);
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, 'artifacts.mjs'), "throw new Error('WRONG CWD COMPANION');\n");
  const result = installedRound(f);
  healthy(result);
  assert.equal(result.calls.new, 2);
  assert.equal(result.calls.run.length, 18);
  assert.equal(result.exit.round, 2);
  assert.equal(result.calls.readonly.at(-1), true);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json', 'round-0002.json']);
  assert.equal(readJSON(result.exit.latest_snapshot).source.origin, f.sourcePath);
  assert.equal(result.calls.run[9].options.input.snapshot.round, 1);
  assert.deepEqual(result.shellCalls.map(({ command }) => operationOf(command)).filter((op) => !op?.startsWith('output-')), [
    null, 'prepare', 'schemas', 'input', 'begin', ...Array(8).fill('stage'), 'finish', 'load',
    'input', 'begin', ...Array(8).fill('stage'), 'finish',
  ]);
  assert.deepEqual(readFileSync(installed), before, 'Never regenerate the discovered workflow.');
  assert.deepEqual(readFileSync(WORKFLOW), before);
});

test('canonical source repository-root fallback works without an installed link', () => {
  const f = fixture();
  const source = packageFixture(f, packageName);
  const result = installedRound(f, { file: source });
  healthy(result);
  assert.equal(result.exit.round, 1);
  assert.equal(result.calls.run.length, 9);
});

test('project, canonical package, config and artifacts paths keep shell syntax inert', () => {
  const f = fixture({ name: "architecture-installed-'$()`-" });
  const marker = join(f.directory, 'MUST_NOT_EXIST');
  const source = packageFixture(f, "canonical ' \" $(touch MUST_NOT_EXIST) `touch MUST_NOT_EXIST` ; $HOME");
  linkProject(f, source);
  const document = "strategy ' \" $(touch MUST_NOT_EXIST).md";
  const output = "output ' \" `touch MUST_NOT_EXIST`";
  const config = "config ' \" $(touch MUST_NOT_EXIST).json";
  writeFileSync(join(f.directory, document), 'Orders are accepted.\n');
  writeJSON(join(f.directory, config), { document, output, max_rounds: 1 });
  const result = installedRound(f, { args: config });
  healthy(result);
  assert.equal(result.exit.round, 1);
  assert.equal(result.exit.latest_snapshot, join(f.directory, output, 'round-0001.json'));
  assert.equal(readJSON(result.exit.latest_snapshot).source.origin, join(f.directory, document));
  assert.equal(existsSync(marker), false);
});

test('foreign root without installed link fails rather than guessing a cwd helper', () => {
  const f = fixture();
  const decoy = join(f.directory, packageName);
  mkdirSync(decoy, { recursive: true });
  copyFileSync(COMPANION, join(decoy, 'artifacts.mjs'));
  failedBeforeWrites(f, installedRound(f, { file: WORKFLOW }), /preflight failed/i);
});

test('broken installed link cannot fall back to an otherwise valid repository package', () => {
  const f = fixture();
  packageFixture(f, packageName);
  linkProject(f, join(f.directory, 'missing-package/architecture-iteration.js'));
  failedBeforeWrites(f, installedRound(f, { file: WORKFLOW }), /preflight failed/i);
});

test('installed ordinary file is refused even when it is byte-identical source', () => {
  const f = fixture();
  const installed = join(f.directory, installedName);
  mkdirSync(dirname(installed), { recursive: true });
  copyFileSync(WORKFLOW, installed);
  failedBeforeWrites(f, installedRound(f), /must be a symlink/i);
});

test('installed target with a different filename is not a canonical package entry', () => {
  const f = fixture();
  const source = join(f.directory, 'unrelated.js');
  copyFileSync(WORKFLOW, source);
  linkProject(f, source);
  failedBeforeWrites(f, installedRound(f), /canonical.*filename/i);
});

test('unrelated workflow plus adjacent helper cannot pass the package preflight', () => {
  const f = fixture();
  const source = join(f.directory, 'unrelated/architecture-iteration.js');
  mkdirSync(dirname(source));
  writeFileSync(source, 'return defineWorkflow((workflow) => workflow.exit({reason:"unrelated"}));\n');
  const marker = join(f.directory, 'WRONG_HELPER_EXECUTED');
  writeFileSync(join(dirname(source), 'artifacts.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'wrong');\n`);
  linkProject(f, source);
  failedBeforeWrites(f, installedRound(f, { file: WORKFLOW }), /does not target this architecture workflow package/i);
  assert.equal(existsSync(marker), false);
});

test('missing adjacent helper fails before the first artifact operation', () => {
  const f = fixture();
  linkProject(f, packageFixture(f, 'incomplete package', { helper: false }));
  failedBeforeWrites(f, installedRound(f), /preflight failed/i);
});

test('helper symlink outside the canonical package is refused', () => {
  const f = fixture();
  const source = packageFixture(f, 'redirected package', { helper: false });
  symlinkSync(COMPANION, join(dirname(source), 'artifacts.mjs'));
  linkProject(f, source);
  failedBeforeWrites(f, installedRound(f), /regular file beside/i);
});

test('conflicting installed and repository workflow packages fail rather than choosing one helper', () => {
  const f = fixture();
  packageFixture(f, packageName);
  linkProject(f);
  failedBeforeWrites(f, installedRound(f), /conflicts.*ambiguous companion/i);
});

test('descendant cwd does not scan ancestors for an installed package', () => {
  const f = fixture();
  const installed = linkProject(f);
  const cwd = join(f.directory, 'descendant');
  mkdirSync(cwd);
  failedBeforeWrites(f, installedRound(f, { file: installed, cwd, args: f.configPath }), /preflight failed/i);
});

for (const [name, corrupt] of [
  ['truncated', (r) => ({ ...r, truncated: true })],
  ['killed', (r) => ({ ...r, killed: true })],
  ['failed exit', (r) => ({ ...r, ok: false, exitCode: 9 })],
  ['missing output', (r) => ({ ...r, output: undefined })],
  ['non-JSON', (r) => ({ ...r, output: 'not JSON' })],
  ['non-object packet', (r) => ({ ...r, output: '[]' })],
  ['oversize', (r) => ({ ...r, output: 'x'.repeat(45 * 1024) })],
  ['extra success key', (r) => ({ ...r, output: JSON.stringify({ ...JSON.parse(r.output), extra: true }) })],
]) test(`resolver transport ${name} stops before writes, resets and model turns`, () => {
  const f = fixture();
  linkProject(f);
  failedBeforeWrites(f, installedRound(f, { shellResultStub: corrupt }));
});

for (const [name, mutate] of [
  ['wrong binding', (data) => { data.binding = 'another-package'; }],
  ['wrong sibling', (data) => { data.companion = '/other/artifacts.mjs'; }],
  ['relative source', (data) => { data.source = 'architecture-iteration.js'; data.companion = 'artifacts.mjs'; }],
  ['wrong entry filename', (data) => { data.source = '/tmp/other.js'; data.companion = '/tmp/artifacts.mjs'; }],
  ['unsafe newline', (data) => { data.source = '/tmp/\n/architecture-iteration.js'; data.companion = '/tmp/\n/artifacts.mjs'; }],
  ['extra binding field', (data) => { data.extra = true; }],
]) test(`resolver acknowledgement ${name} cannot select another companion`, () => {
  const f = fixture();
  linkProject(f);
  failedBeforeWrites(f, installedRound(f, { shellResultStub: (reply) => {
    const packet = JSON.parse(reply.output);
    mutate(packet.data);
    return { ...reply, output: JSON.stringify(packet) };
  } }), /invalid canonical companion binding/i);
});
