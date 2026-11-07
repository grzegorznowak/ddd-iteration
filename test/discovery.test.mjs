import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './support.mjs';

// Optional, offline, without launching Pi or scanning user directories:
// ARCHITECTURE_SKILL_LOADER=/absolute/pi-coding-agent/dist/core/skills.js \
// node --test test/discovery.test.mjs
// Use the real installed module at an explicit path; no copied parser, live/global
// installation or Pi/model launch. Retain temporary evidence, as in the other tests.
const loaderPath = process.env.ARCHITECTURE_SKILL_LOADER;
test('actual selected Pi loader discovers all five skills through installed project symlinks', {
  skip: loaderPath ? false : 'Set ARCHITECTURE_SKILL_LOADER to opt into native offline skill discovery.',
}, async () => {
  assert.ok(isAbsolute(loaderPath), 'Use an absolute installed Pi skill-loader path.');
  const { loadSkillsFromDir, formatSkillsForPrompt } = await import(pathToFileURL(loaderPath).href);
  assert.equal(typeof loadSkillsFromDir, 'function');
  const { install } = await import('../install.mjs');
  const project = mkdtempSync(join(tmpdir(), 'architecture-discovery-'));
  const packageRoot = realpathSync(ROOT);
  const expected = ['expert', 'journey', 'master', 'model', 'stressor'].map((voice) => `architecture-iteration-${voice}`);
  const result = install({ project });
  assert.equal(result.project, realpathSync(project));
  assert.equal(result.dryRun, false);
  assert.equal(result.links.length, 7);
  assert.ok(result.links.every((link) => link.status === 'linked'));
  const workflowCopy = join(project, '.pi/workflows/architecture-iteration.js');
  assert.ok(lstatSync(workflowCopy).isFile());
  assert.equal(lstatSync(workflowCopy).isSymbolicLink(), false);
  assert.equal(readFileSync(workflowCopy, 'utf8'), readFileSync(join(packageRoot, 'architecture-iteration.js'), 'utf8'));
  const companionCopy = join(project, '.pi/workflows/artifacts.mjs');
  assert.ok(lstatSync(companionCopy).isFile());
  assert.equal(readFileSync(companionCopy, 'utf8'), readFileSync(join(packageRoot, 'artifacts.mjs'), 'utf8'));
  const dir = join(project, '.pi/skills');
  for (const name of expected) {
    const destination = join(dir, name);
    assert.ok(lstatSync(destination).isSymbolicLink(), destination);
    assert.equal(realpathSync(destination), join(packageRoot, 'skills', name));
  }

  const { skills, diagnostics } = loadSkillsFromDir({ dir, source: 'project' });
  assert.deepEqual(skills.map((skill) => skill.name).sort(), expected);
  assert.deepEqual(diagnostics, []);
  const prompt = formatSkillsForPrompt(skills);
  for (const skill of skills) {
    // Pi versions can report discovery paths or canonical source paths. Both must
    // identify the canonical skill, and the prompt must use the loader's path.
    const sourceDir = join(packageRoot, 'skills', skill.name);
    assert.equal(realpathSync(skill.filePath), join(sourceDir, 'SKILL.md'));
    assert.equal(realpathSync(skill.baseDir), sourceDir);
    assert.ok(skill.description.trim().length > 0);
    assert.equal(skill.disableModelInvocation, false);
    assert.equal(skill.sourceInfo.scope, 'project');
    assert.ok(prompt.includes(`<name>${skill.name}</name>`));
    assert.ok(prompt.includes(skill.filePath));
  }
});
