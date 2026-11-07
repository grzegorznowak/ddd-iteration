#!/usr/bin/env node
// One source package. The workflow and its artifact companion are delivered as
// regular copies so the host's /workflows list (which ignores symlinked .js
// files) shows the workflow; skill discovery follows links, so skills stay
// symlinks to the canonical source.
// Single mode: the current working directory is the project. No choices.
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const VOICES = ['master', 'expert', 'journey', 'model', 'stressor'];
const HELP = `Usage: node install.mjs [--dry-run]

Install this package's workflow (regular copies of the workflow and its artifact
companion) and five skills (symlinks) into the .pi discovery folders of the
current working directory (the project). No global install or overwrites.
Run Pi from this directory; reload resources after installation. The workflow
copy appears in the /workflows list.

A previously installed correct workflow symlink is upgraded to the copy on rerun.
Changing the canonical workflow requires removing the old .pi/workflows copies
before rerunning (an identical copy reports existing; a different copy is a
refused conflict).

  --dry-run   Check every source and destination without changing files.
  --help      Show this help.
`;

function entry(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function directory(path) {
  const info = entry(path);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`Conflict: discovery directory must be an ordinary directory: ${path}`);
  }
}
function sameBytes(a, b) {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

export function install({ project = process.cwd(), dryRun = false } = {}) {
  const root = realpathSync(resolve(project));
  if (!statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const pi = join(root, '.pi');
  const workflows = join(pi, 'workflows');
  const skills = join(pi, 'skills');
  // Inspect parents first. In particular, do not follow a discovery-directory
  // symlink and accidentally change another project or a user's global assets.
  for (const path of [pi, workflows, skills]) directory(path);
  const entries = [
    { source: join(PACKAGE, 'architecture-iteration.js'), destination: join(workflows, 'architecture-iteration.js'), kind: 'file' },
    { source: join(PACKAGE, 'artifacts.mjs'), destination: join(workflows, 'artifacts.mjs'), kind: 'file' },
    ...VOICES.map((voice) => {
      const name = `architecture-iteration-${voice}`;
      return { source: join(PACKAGE, 'skills', name), destination: join(skills, name), kind: 'dir' };
    }),
  ];
  for (const item of entries) {
    const source = lstatSync(item.source);
    if (source.isSymbolicLink() || !(item.kind === 'dir' ? source.isDirectory() : source.isFile())) {
      throw new Error(`Package source is not an ordinary ${item.kind}: ${item.source}`);
    }
    if (item.kind === 'dir' && !statSync(join(item.source, 'SKILL.md')).isFile()) {
      throw new Error(`Package skill is missing SKILL.md: ${item.source}`);
    }
    const existing = entry(item.destination);
    if (!existing) {
      item.status = dryRun ? 'planned' : 'linked';
      continue;
    }
    let correct = false;
    if (existing.isSymbolicLink()) {
      // A previously installed correct symlink counts as existing, never replaced —
      // except the workflow/companion files, which are upgraded to copies so the
      // host lists the workflow.
      try { correct = realpathSync(item.destination) === realpathSync(item.source); } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ELOOP' && error.code !== 'ENOTDIR') throw error;
      }
      if (correct && item.kind === 'file') {
        item.upgrade = true;
        item.status = dryRun ? 'planned' : 'upgraded';
        continue;
      }
    } else if (item.kind === 'file' && existing.isFile()) {
      // An identical copy counts as existing; a different file is a conflict.
      correct = sameBytes(item.destination, item.source);
    }
    if (!correct) throw new Error(`Conflict: refusing to replace existing asset: ${item.destination}`);
    item.status = 'existing';
  }
  if (!dryRun) {
    for (const path of [pi, workflows, skills]) {
      // Recheck before creation; creation itself never overwrites.
      directory(path);
      mkdirSync(path, { recursive: true });
    }
    for (const item of entries) {
      if (item.status === 'upgraded') {
        unlinkSync(item.destination);
        copyFileSync(item.source, item.destination);
      } else if (item.status !== 'existing') {
        if (item.kind === 'dir') {
          symlinkSync(relative(dirname(item.destination), item.source), item.destination, 'dir');
        } else {
          copyFileSync(item.source, item.destination);
        }
      }
    }
  }
  return { project: root, dryRun, links: entries.map(({ source, destination, status }) => ({ source, destination, status })) };
}

function main(args) {
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--help' && args.length === 1) { process.stdout.write(HELP); return; }
    if (arg === '--dry-run' && !dryRun) { dryRun = true; continue; }
    throw new Error(`Invalid argument: ${arg}. Use --help.`);
  }
  const result = install({ dryRun });
  for (const link of result.links) process.stdout.write(`${link.status}: ${link.destination} -> ${link.source}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`Installation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
