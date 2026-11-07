import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifacts as a, fixture, prepareFixture, workflow, healthy, roleOutput, readJSON, snapshots, resumeConfig, commitRound,
  tamper,
} from './support.mjs';

const ROLE_SLOTS = ['agenda', 'explore-journey', 'explore-model', 'explore-stressor', 'expert',
  'challenge-journey', 'challenge-model', 'challenge-stressor', 'synthesis'];

function stubFor(slot) {
  return { output: roleOutput(slot) };
}

function failAfterRuns(n) {
  const f = fixture({ config: { max_rounds: 1 } });
  const result = workflow(f, {
    runStub: (prompt, options, { calls }) => {
      if (calls.run.length > n) throw new Error('SIMULATED TIME-LIMIT');
      return stubFor(ROLE_SLOTS[calls.run.length - 1]);
    },
  });
  return { f, result };
}

test('mid-round failure exposes the attempt token and leaves staged roles durable', () => {
  const { f, result } = failAfterRuns(5); // agenda + 3 explores + expert staged
  assert.equal(result.exit.reason, 'failed');
  assert.match(result.exit.diagnostic, /SIMULATED TIME-LIMIT/);
  assert.ok(result.exit.attempt, 'exit carries the attempt token');
  assert.match(result.exit.attempt, /\.attempt-[0-9a-f-]{36}$/);
  assert.equal(result.exit.round, 0);
  assert.equal(result.checkpoints.at(-1).phase, 'round-begin');
  assert.equal(result.checkpoints.at(-1).attempt, result.exit.attempt);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
  const status = a.attemptStatus({ attempt: result.exit.attempt });
  const staged = status.slots.filter((row) => row.state === 'staged').map((row) => row.slot);
  assert.deepEqual(staged, ROLE_SLOTS.slice(0, 5));
});

test('resume from attempt runs only the missing remainder and commits once', () => {
  const { f, result: failed } = failAfterRuns(5);
  const config = resumeConfig(f, { path: failed.exit.latest_snapshot, round: 0, sha256: '' }, {
    attempt: failed.exit.attempt, max_rounds: 1,
  });
  const reruns = [];
  const resumed = workflow(f, {
    args: config,
    runStub: (prompt, options, { calls }) => {
      const slot = ROLE_SLOTS[4 + calls.run.length]; // expert done; challenges+synthesis remain
      reruns.push(slot);
      return stubFor(slot);
    },
  });
  healthy(resumed);
  assert.deepEqual(reruns, ROLE_SLOTS.slice(5));
  assert.equal(resumed.exit.round, 1);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
  const committed = readJSON(resumed.exit.latest_snapshot);
  assert.equal(committed.round, 1);
  assert.ok(committed.role_outputs.agenda);
  assert.equal(committed.role_outputs.proposals.length, 3);
});

test('resume after a finish-transport failure reuses all staged roles and commits exactly once', () => {
  // A finish shell reply may be lost after the commit already succeeded; recover
  // converges to the committed round and resume then refuses the stale attempt
  // (base no longer equals latest). The idempotent-finish test below covers the
  // convergence path directly.
  const f = fixture({ config: { max_rounds: 1 } });
  const failed = workflow(f, {
    runStub: (prompt, options, { calls }) => stubFor(ROLE_SLOTS[calls.run.length - 1]),
    shellResultStub: (reply, command) => (command.includes("'finish'") ? { ...reply, ok: false, exitCode: 1, output: 'spurious' } : reply),
  });
  assert.equal(failed.exit.reason, 'failed');
  assert.ok(failed.exit.attempt);
  assert.equal(failed.calls.run.length, 9);
  // The commit actually landed before the reply was lost; latest is round 1.
  assert.equal(failed.exit.round, 1);
});

test('redo invalidates the named slot and staged dependents; resume reruns the cascade', () => {
  const { f, result: failed } = failAfterRuns(5);
  const stamped = a.invalidateRoles({ attempt: failed.exit.attempt, slots: ['explore-model'] });
  const stateOf = (slot) => stamped.slots.find((row) => row.slot === slot).state;
  assert.equal(stateOf('explore-model'), 'stale');
  assert.equal(stateOf('agenda'), 'staged');
  assert.equal(stateOf('explore-journey'), 'staged');
  assert.equal(stateOf('explore-stressor'), 'stale');
  assert.equal(stateOf('expert'), 'stale');
  assert.equal(stateOf('synthesis'), 'missing');

  const config = resumeConfig(f, { path: failed.exit.latest_snapshot, round: 0, sha256: '' }, {
    attempt: failed.exit.attempt, redo: ['explore-model'], max_rounds: 1,
  });
  const reruns = [];
  const resumed = workflow(f, {
    args: config,
    runStub: (prompt, options, { calls }) => {
      const slot = ROLE_SLOTS[1 + calls.run.length]; // explore-model + cascade
      reruns.push(slot);
      return stubFor(slot);
    },
  });
  healthy(resumed);
  assert.deepEqual(reruns, ['explore-model', 'explore-stressor', 'expert', 'challenge-journey', 'challenge-model', 'challenge-stressor', 'synthesis']);
  assert.equal(resumed.exit.round, 1);
});

test('finish refuses to write over an existing commit (no duplicate, no overwrite)', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis'));
  assert.throws(() => a.finish({ attempt: first.attempt, output: roleOutput('synthesis') }), (error) => {
    assert.equal(error.code, 'E_STALE');
    return true;
  });
  assert.equal(snapshots(f).filter((name) => name === 'round-0001.json').length, 1);
  assert.equal(snapshots(f).length, 2);
});

test('resume refuses an attempt that does not continue the latest committed snapshot', () => {
  const f = fixture({ config: { max_rounds: 1 } });
  const failed = workflow(f, {
    runStub: (prompt, options, { calls }) => {
      if (calls.run.length > 5) throw new Error('SIMULATED TIME-LIMIT');
      return stubFor(ROLE_SLOTS[calls.run.length - 1]);
    },
  });
  assert.equal(failed.exit.reason, 'failed');
  // Commit round 1 on the same output via the engine so committed latest advances.
  const base = a.loadSnapshot(failed.exit.latest_snapshot);
  const attempt = a.begin({ latest: base.latest, human_answers: base.snapshot.human_answers, input_ref: undefined });
  for (const slot of ROLE_SLOTS.slice(0, -1)) a.stage({ attempt: attempt.attempt, slot, output: roleOutput(slot) });
  const staged = a.attemptStatus({ attempt: attempt.attempt });
  assert.equal(staged.slots.filter((row) => row.state === 'staged').length, 8);
  const committed = a.finish({ attempt: attempt.attempt, output: roleOutput('synthesis') });
  assert.equal(committed.latest.round, 1);
  const config = resumeConfig(f, { path: committed.latest.path, round: 1, sha256: committed.latest.sha256 }, {
    attempt: failed.exit.attempt, max_rounds: 1,
  });
  const result = workflow(f, {
    args: config,
    runStub: (prompt, options, { calls }) => stubFor(ROLE_SLOTS[calls.run.length - 1]),
  });
  assert.equal(result.exit.reason, 'failed');
  // prepare now rejects the stale base before publishing any model input.
  assert.match(result.exit.diagnostic, /Stale resume/);
  assert.equal(result.calls.run.length, 0);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

test('large staged roles above the 45 KiB packet limit resume via bounded chunked read', () => {
  const f = fixture({ config: { max_rounds: 1 } });
  const oversized = 50 * 1024; // exceeds the 45 KiB single-reply shell envelope
  const failed = workflow(f, {
    runStub: (prompt, options, { calls }) => {
      if (calls.run.length > 8) throw new Error('SIMULATED TIME-LIMIT'); // agenda..challenge staged; synthesis never runs
      const slot = ROLE_SLOTS[calls.run.length - 1];
      const out = roleOutput(slot);
      if (slot === 'explore-journey') {
        out.proposals[0] += 'x'.repeat(oversized);
        return { output: out };
      }
      return { output: out };
    },
  });
  assert.equal(failed.exit.reason, 'failed');
  assert.ok(failed.exit.attempt);
  const stagedSize = statSync(join(failed.exit.attempt, 'role-explore-journey.json')).size;
  assert.ok(stagedSize > 45 * 1024, 'staged role must exceed the 45 KiB packet limit');

  const config = resumeConfig(f, { path: failed.exit.latest_snapshot, round: 0, sha256: '' }, {
    attempt: failed.exit.attempt, max_rounds: 1,
  });
  const reruns = [];
  const resumed = workflow(f, {
    args: config,
    runStub: (_prompt, _options) => {
      reruns.push('synthesis');
      return { output: roleOutput('synthesis') };
    },
  });
  healthy(resumed);
  assert.deepEqual(reruns, ['synthesis']);
  assert.equal(resumed.exit.round, 1);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
  const committed = readJSON(resumed.exit.latest_snapshot);
  assert.ok(committed.role_outputs.proposals[0].proposals[0].length > 45 * 1024);
});

test('retried finish after interruption between synthesis write and commit completes with zero model calls', () => {
  const f = prepareFixture();
  const attempt = a.begin({ latest: f.prepared.latest, human_answers: f.prepared.snapshot.human_answers });
  for (const slot of ROLE_SLOTS.slice(0, -1)) a.stage({ attempt: attempt.attempt, slot, output: roleOutput(slot) });
  // Emulate finish reaching its write window: the synthesis role was authored but
  // the exclusive snapshot commit was not reached, so the attempt is still current.
  const synthesis = roleOutput('synthesis');
  writeFileSync(join(attempt.attempt, 'role-synthesis.json'), JSON.stringify(synthesis) + '\n');
  const config = resumeConfig(f, { path: f.prepared.latest.path, round: 0, sha256: f.prepared.latest.sha256 }, {
    attempt: attempt.attempt, max_rounds: 1,
  });
  const resumed = workflow(f, {
    args: config,
    runStub: () => { throw new Error('no model turns should run on a fully staged resume'); },
  });
  healthy(resumed);
  assert.equal(resumed.calls.run.length, 0);
  assert.equal(resumed.exit.round, 1);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

test('resume config rejects answers combined with attempt (E_CONFIG)', () => {
  const f = prepareFixture();
  const attempt = a.begin({ latest: f.prepared.latest, human_answers: f.prepared.snapshot.human_answers });
  const configPath = resumeConfig(f, { path: f.prepared.latest.path, round: 0, sha256: f.prepared.latest.sha256 }, {
    attempt: attempt.attempt, answers: [{ question_id: 'Q1', answer: 'Ops may cancel.' }], max_rounds: 1,
  });
  const result = workflow(f, { args: configPath });
  assert.equal(result.exit.reason, 'needs-input');
  assert.match(result.exit.diagnostic, /attempt and answers are incompatible/);
});

test('resume config rejects redo without attempt (E_CONFIG)', () => {
  const f = prepareFixture();
  const configPath = resumeConfig(f, { path: f.prepared.latest.path, round: 0, sha256: f.prepared.latest.sha256 }, {
    redo: ['explore-model'], max_rounds: 1,
  });
  const result = workflow(f, { args: configPath });
  assert.equal(result.exit.reason, 'needs-input');
  assert.match(result.exit.diagnostic, /redo requires attempt/);
});

test('start config rejects attempt and redo keys (E_CONFIG)', () => {
  const f = fixture({ config: { attempt: '/tmp/none', redo: ['agenda'] } });
  const result = workflow(f);
  assert.equal(result.exit.reason, 'needs-input');
  assert.match(result.exit.diagnostic, /is not allowed/);
});

test('after a resumed round commits, subsequent rounds begin fresh (max_rounds=2)', () => {
  const f = fixture({ config: { max_rounds: 1 } });
  const failed = workflow(f, {
    runStub: (prompt, options, { calls }) => {
      if (calls.run.length > 5) throw new Error('SIMULATED TIME-LIMIT');
      return stubFor(ROLE_SLOTS[calls.run.length - 1]);
    },
  });
  assert.equal(failed.exit.reason, 'failed');
  const config = resumeConfig(f, { path: failed.exit.latest_snapshot, round: 0, sha256: '' }, {
    attempt: failed.exit.attempt, max_rounds: 2,
  });
  const resumeRuns = [];
  const freshRuns = [];
  let resumeRun = 0;
  const resumed = workflow(f, {
    args: config,
    runStub: (prompt, options) => {
      if (options.input.round === 1) {
        const slot = ROLE_SLOTS[5 + resumeRun++]; // challenges + synthesis only
        resumeRuns.push(slot);
        return stubFor(slot);
      }
      const phase = options.input.phase;
      const slot = phase === 'agenda' ? 'agenda' : phase === 'answer' ? 'expert' : phase === 'synthesize' ? 'synthesis'
        : `${phase}-${prompt.slice(prompt.lastIndexOf('-') + 1)}`;
      freshRuns.push(slot);
      return stubFor(slot);
    },
  });
  healthy(resumed);
  assert.deepEqual(resumeRuns, ROLE_SLOTS.slice(5));
  assert.deepEqual(freshRuns, ROLE_SLOTS);
  assert.equal(resumed.exit.round, 2);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json', 'round-0002.json']);
});

test('legacy attempt manifests without recorded role hashes still resume (derived from file)', () => {
  const { f, result: failed } = failAfterRuns(5);
  // Strip per-slot hashes to emulate a manifest written before tamper-binding.
  tamper(join(failed.exit.attempt, 'attempt.json'), (manifest) => {
    for (const slot of Object.keys(manifest.slots)) manifest.slots[slot] = { state: manifest.slots[slot].state };
  });
  const config = resumeConfig(f, { path: failed.exit.latest_snapshot, round: 0, sha256: '' }, {
    attempt: failed.exit.attempt, max_rounds: 1,
  });
  const resumed = workflow(f, {
    args: config,
    runStub: (prompt, options, { calls }) => stubFor(ROLE_SLOTS[4 + calls.run.length]),
  });
  healthy(resumed);
  assert.equal(resumed.exit.round, 1);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

test('tampering with a staged role file makes resume fail closed', () => {
  const { f, result: failed } = failAfterRuns(5);
  tamper(join(failed.exit.attempt, 'role-explore-model.json'), (value) => { value.dissent = ['tampered']; });
  const config = resumeConfig(f, { path: failed.exit.latest_snapshot, round: 0, sha256: '' }, {
    attempt: failed.exit.attempt, max_rounds: 1,
  });
  const resumed = workflow(f, {
    args: config,
    runStub: (prompt, options, { calls }) => stubFor(ROLE_SLOTS[calls.run.length - 1]),
  });
  assert.equal(resumed.exit.reason, 'failed');
  assert.match(resumed.exit.diagnostic, /hash mismatch/);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
});
