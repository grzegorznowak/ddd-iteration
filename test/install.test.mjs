import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { install } from '../install.mjs';
import { fixture, healthy, roleOutput } from './support.mjs';
import { runWorkflow } from './harness.mjs';

const PACKAGE = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const INSTALLER = join(PACKAGE, 'install.mjs');
const NAMES = ['master', 'expert', 'journey', 'model', 'stressor'].map((voice) => `architecture-iteration-${voice}`);
// Only new temporary fixtures; retain evidence and never remove existing assets.
const project = () => mkdtempSync(join(tmpdir(), 'architecture-install-'));
const cli = (args, cwd = PACKAGE) => spawnSync(process.execPath, [INSTALLER, ...args], {
  cwd, encoding: 'utf8', timeout: 10_000,
});

function verifyLinks(root, result) {
  assert.equal(result.project, realpathSync(root));
  assert.equal(result.links.length, 6);
  const expected = [
    [join(root, '.pi/workflows/architecture-iteration.js'), join(PACKAGE, 'architecture-iteration.js')],
    ...NAMES.map((name) => [join(root, '.pi/skills', name), join(PACKAGE, 'skills', name)]),
  ];
  for (const [destination, source] of expected) {
    assert.ok(lstatSync(destination).isSymbolicLink());
    assert.equal(isAbsolute(readlinkSync(destination)), false, 'Discovery link is relative.');
    assert.equal(realpathSync(destination), source);
    assert.ok(result.links.some((link) => link.source === source && link.destination === destination));
  }
}

test('install once, rerun without changing links, preserve unrelated project assets', () => {
  const root = project();
  const unrelated = join(root, '.pi/skills/unrelated/SKILL.md');
  mkdirSync(dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, 'keep this resource');
  const first = install({ project: root });
  verifyLinks(root, first);
  assert.ok(first.links.every((link) => link.status === 'linked'));
  const prior = first.links.map((link) => lstatSync(link.destination));
  const second = install({ project: root });
  verifyLinks(root, second);
  assert.ok(second.links.every((link) => link.status === 'existing'));
  for (const [index, link] of second.links.entries()) {
    const current = lstatSync(link.destination);
    assert.equal(current.ino, prior[index].ino);
    assert.equal(current.mtimeMs, prior[index].mtimeMs);
  }
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep this resource');
});

test('dry-run makes no discovery folders, then reports existing links after install', () => {
  const root = project();
  const result = install({ project: root, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.links.every((link) => link.status === 'planned'));
  assert.deepEqual(readdirSync(root), []);
  install({ project: root });
  assert.ok(install({ project: root, dryRun: true }).links.every((link) => link.status === 'existing'));
});

for (const kind of ['file', 'directory', 'wrong-link', 'broken-link', 'loop-link', 'identical-copy']) {
  test(`last skill ${kind} conflict prevents every new link`, () => {
    const root = project();
    const destination = join(root, '.pi/skills/architecture-iteration-stressor');
    mkdirSync(dirname(destination), { recursive: true });
    if (kind === 'file') writeFileSync(destination, 'preserve');
    if (kind === 'directory' || kind === 'identical-copy') {
      mkdirSync(destination);
      writeFileSync(join(destination, 'SKILL.md'), kind === 'identical-copy'
        ? readFileSync(join(PACKAGE, 'skills/architecture-iteration-stressor/SKILL.md')) : 'preserve');
    }
    if (kind === 'wrong-link') symlinkSync(join(PACKAGE, 'skills/architecture-iteration-master'), destination);
    if (kind === 'broken-link') symlinkSync('missing-skill', destination);
    if (kind === 'loop-link') symlinkSync('architecture-iteration-stressor', destination);
    const before = lstatSync(destination);
    for (const dryRun of [true, false]) {
      assert.throws(() => install({ project: root, dryRun }), /Conflict/);
      assert.equal(lstatSync(destination).ino, before.ino);
      assert.equal(existsSync(join(root, '.pi/workflows')), false);
      assert.equal(existsSync(join(root, '.pi/skills/architecture-iteration-master')), false);
    }
  });
}

for (const parent of ['.pi', '.pi/skills', '.pi/workflows']) {
  for (const kind of ['file', 'symlink', 'broken-link']) test(`${parent} ${kind} is rejected without following it`, () => {
    const root = project();
    const external = project();
    const destination = join(root, parent);
    mkdirSync(dirname(destination), { recursive: true });
    if (kind === 'file') writeFileSync(destination, 'preserve');
    else symlinkSync(kind === 'symlink' ? external : join(root, 'missing'), destination);
    assert.throws(() => install({ project: root }), /Conflict/);
    assert.deepEqual(readdirSync(external), []);
    assert.equal(lstatSync(destination).isSymbolicLink(), kind !== 'file');
  });
}

test('workflow conflict is not overwritten', () => {
  const root = project();
  mkdirSync(join(root, '.pi/workflows'), { recursive: true });
  const destination = join(root, '.pi/workflows/architecture-iteration.js');
  writeFileSync(destination, 'keep workflow');
  assert.throws(() => install({ project: root }), /Conflict/);
  assert.equal(readFileSync(destination, 'utf8'), 'keep workflow');
  assert.equal(existsSync(join(root, '.pi/skills')), false);
});

test('equivalent absolute links are recognized, not replaced', () => {
  const root = project();
  const destination = join(root, '.pi/workflows/architecture-iteration.js');
  mkdirSync(dirname(destination), { recursive: true });
  const source = join(PACKAGE, 'architecture-iteration.js');
  symlinkSync(source, destination);
  const result = install({ project: root });
  assert.equal(result.links[0].status, 'existing');
  assert.equal(readlinkSync(destination), source);
});

test('CLI installs into the current working directory and keeps shell characters inert', () => {
  const root = project();
  const target = join(root, "project ' $(touch MUST_NOT_EXIST) `touch MUST_NOT_EXIST`");
  mkdirSync(target);
  const preview = cli(['--dry-run'], target);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /planned:/);
  assert.deepEqual(readdirSync(target), []);
  const result = cli([], target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'MUST_NOT_EXIST')), false);
  verifyLinks(target, install({ project: target }));
});

for (const args of [['--project'], ['--global'], ['--force'], ['--dry-run', '--dry-run'], ['--project', '.', '--project', '.'], ['--help', '--dry-run']]) {
  test(`CLI rejects ${JSON.stringify(args)} without side effects`, () => {
    const root = project();
    const result = cli(args, root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid argument/);
    assert.deepEqual(readdirSync(root), []);
  });
}

test('CLI help is side-effect free and unknown flags fail without side effects', () => {
  const root = project();
  const help = cli(['--help'], root);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const bad = cli(['--project'], root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid argument/);
  assert.deepEqual(readdirSync(root), []);
});

test('CLI dry-run previews the cwd project without writing', () => {
  const root = project();
  const result = cli(['--dry-run'], root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(join(root, '.pi/workflows/architecture-iteration.js')));
  assert.deepEqual(readdirSync(root), []);
});

test('actual installer links run a complete deterministic foreign-project round', () => {
  const f = fixture({ name: 'architecture-install-round-' });
  install({ project: f.directory });
  const result = runWorkflow({ file: join(f.directory, '.pi/workflows/architecture-iteration.js'), cwd: f.directory,
    args: 'start.json', newStub: ({ state }) => { state.readonly = false; },
    runStub: (prompt, options) => {
      const phase = options.input.phase;
      const slot = phase === 'agenda' ? 'agenda' : phase === 'answer' ? 'expert' : phase === 'synthesize' ? 'synthesis'
        : `${phase}-${prompt.slice(prompt.lastIndexOf('-') + 1)}`;
      return { output: roleOutput(slot) };
    },
  });
  healthy(result);
  assert.equal(result.calls.new, 1);
  assert.equal(result.calls.run.length, 9);
  assert.equal(result.exit.round, 1);
});
