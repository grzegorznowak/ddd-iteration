#!/usr/bin/env node
// One source package; discovery entries are links, never maintained copies.
// Single mode: the current working directory is the project. No choices.
import { lstatSync, mkdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const VOICES = ['master', 'expert', 'journey', 'model', 'stressor'];
const HELP = `Usage: node install.mjs [--dry-run]

Link this package's workflow and five skills into the .pi discovery folders of
the current working directory (the project). No global install or overwrites.
Run Pi from this directory; reload resources after installation.

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

export function install({ project = process.cwd(), dryRun = false } = {}) {
  const root = realpathSync(resolve(project));
  if (!statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const pi = join(root, '.pi');
  const workflows = join(pi, 'workflows');
  const skills = join(pi, 'skills');
  // Inspect parents first. In particular, do not follow a discovery-directory
  // symlink and accidentally change another project or a user's global assets.
  for (const path of [pi, workflows, skills]) directory(path);
  const links = [
    { source: join(PACKAGE, 'architecture-iteration.js'), destination: join(workflows, 'architecture-iteration.js'), kind: 'file' },
    ...VOICES.map((voice) => {
      const name = `architecture-iteration-${voice}`;
      return { source: join(PACKAGE, 'skills', name), destination: join(skills, name), kind: 'dir' };
    }),
  ];
  if (!statSync(join(PACKAGE, 'artifacts.mjs')).isFile()) throw new Error('Package companion artifacts.mjs is missing.');
  // Complete preflight before mkdir or symlink. Even byte-identical ordinary
  // copies are conflicts: this installer never removes or replaces an asset.
  for (const link of links) {
    const source = lstatSync(link.source);
    if (source.isSymbolicLink() || !(link.kind === 'dir' ? source.isDirectory() : source.isFile())) {
      throw new Error(`Package source is not an ordinary ${link.kind}: ${link.source}`);
    }
    if (link.kind === 'dir' && !statSync(join(link.source, 'SKILL.md')).isFile()) {
      throw new Error(`Package skill is missing SKILL.md: ${link.source}`);
    }
    const existing = entry(link.destination);
    if (!existing) {
      link.status = dryRun ? 'planned' : 'linked';
      continue;
    }
    let correct = false;
    if (existing.isSymbolicLink()) {
      try { correct = realpathSync(link.destination) === realpathSync(link.source); } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ELOOP' && error.code !== 'ENOTDIR') throw error;
      }
    }
    if (!correct) throw new Error(`Conflict: refusing to replace existing asset: ${link.destination}`);
    link.status = 'existing';
  }
  if (!dryRun) {
    for (const path of [pi, workflows, skills]) {
      // Recheck before creation; symlink creation itself never overwrites.
      directory(path);
      mkdirSync(path, { recursive: true });
    }
    for (const link of links) {
      if (link.status !== 'existing') {
        symlinkSync(relative(dirname(link.destination), link.source), link.destination, link.kind);
      }
    }
  }
  return { project: root, dryRun, links: links.map(({ source, destination, status }) => ({ source, destination, status })) };
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
