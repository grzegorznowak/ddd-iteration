import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifacts as a, fixture, workflow, healthy, roleOutput, clone, readJSON,
  resumeConfig, snapshots, operationOf, VOICES,
} from './support.mjs';

const turns = [
  ['master', 'agenda', 'agenda'],
  ['journey', 'explore', 'explore-journey'], ['model', 'explore', 'explore-model'], ['stressor', 'explore', 'explore-stressor'],
  ['expert', 'answer', 'expert'],
  ['journey', 'challenge', 'challenge-journey'], ['model', 'challenge', 'challenge-model'], ['stressor', 'challenge', 'challenge-stressor'],
  ['master', 'synthesize', 'synthesis'],
];

// Simulate a provider-visible conversation, not just a reset counter. Each role
// appends its expanded instructions, request and result to the live history.
// Replacing the history object (and clearing session-local notebook pages) is the
// only way the next invocation can pass. This is still offline host simulation,
// not proof of the actual provider request/history in a live Pi session.
for (const entryReadonly of [false, true]) test(`each of eighteen calls sees only its explicit packet; readonly=${entryReadonly}`, () => {
  const f = fixture({ source: 'Exact source: \\ " $() 😀\r\nOrders are accepted.\n', config: { max_rounds: 2 } });
  const sessions = [];
  const outputs = new Map();
  const priorRoundBytes = new Map();
  let currentRound;
  let snapshot;
  let resetCount = 0;
  const result = workflow(f, {
    initialState: { readonly: entryReadonly, conversation: { id: 'ambient', history: ['AMBIENT INSTRUCTIONS AND ANSWER'] } },
    newStub: ({ state, calls, pages }) => {
      if (calls.new > 1) {
        assert.equal(state.conversation.history.length, 3);
        assert.equal(pages.size, 1, 'previous voice left private notebook state');
      }
      sessions.push(state.conversation);
      state.conversation = { id: `session-${++resetCount}`, history: [] };
      state.readonly = false; // Exercise runtimes that reset posture.
      pages.clear();
    },
    runStub: (prompt, options, { calls, state, pages }) => {
      const index = (calls.run.length - 1) % 9;
      const [voice, phase, slot] = turns[index];
      const round = Math.floor((calls.run.length - 1) / 9) + 1;
      assert.equal(calls.new, calls.run.length, 'reset immediately before every call, including Master/Expert');
      assert.equal(state.conversation.id, `session-${calls.run.length}`);
      assert.deepEqual(state.conversation.history, [], 'no earlier role instructions, requests or answers');
      assert.equal(pages.size, 0, 'no private notebook state from another invocation');
      assert.equal(state.readonly, true);
      assert.equal(prompt, `/skill:architecture-iteration-${voice}`);
      assert.equal(options.args, `round-${round} ${phase}`);
      assert.deepEqual(calls.order.slice(-3).map((effect) => [effect.handle, effect.readonly]), [
        ['new', calls.order.at(-3).readonly], ['readonly', true], ['run', true],
      ]);
      if (index === 0) {
        currentRound = new Map();
        outputs.set(round, currentRound);
        const path = join(f.outputPath, `round-${String(round - 1).padStart(4, '0')}.json`);
        const previous = readJSON(path);
        snapshot = a.projectSnapshot(previous);
        priorRoundBytes.set(path, readFileSync(path));
        assert.equal(snapshot.round, round - 1);
        assert.equal(Object.hasOwn(snapshot, 'role_outputs'), false);
        assert.equal(JSON.stringify(snapshot).includes('private-role-instruction'), false);
        assert.equal(JSON.stringify(snapshot).includes('current-role-output'), false);
      }
      const packet = { round, phase, snapshot };
      if (index > 0) packet.agenda = currentRound.get('agenda');
      if (index >= 4) packet.proposals = VOICES.map((v) => currentRound.get(`explore-${v}`));
      if (index >= 5) packet.expert = currentRound.get('expert');
      if (index === 8) packet.challenges = VOICES.map((v) => currentRound.get(`challenge-${v}`));
      assert.deepEqual(options.input, packet, 'exact packet: no missing or extra artifacts, no sibling explore/challenge leakage');
      assert.equal(JSON.stringify(options.input).includes('private-role-instruction'), false);
      assert.equal(JSON.stringify(options.input).includes('AMBIENT INSTRUCTIONS'), false);
      if (VOICES.includes(voice)) {
        assert.deepEqual(options.output.schema.properties.voice.enum, [voice]);
        assert.equal(options.output.schema.required.includes('voice'), true);
        assert.equal(options.output.schema.additionalProperties, false);
      }
      state.conversation.history.push(`private-role-instruction:${voice}:${phase}`, clone(options.input));
      const output = roleOutput(slot, { marker: `current-role-output:${round}:${slot}` });
      if (slot === 'expert') output.unresolved.push(`current-role-output:${round}:${slot}`);
      // Synthesis artifacts alone carry forward, not its whole report/transcript.
      if (slot === 'synthesis') output.rationale = `Committed rationale for round ${round}.`;
      currentRound.set(slot, clone(output));
      state.conversation.history.push(clone(output));
      pages.set('voice-private', `private-role-instruction:${voice}:${phase}`);
      return { output };
    },
  });
  // The next round reset must also remove Master synthesis history and notes.
  assert.ifError(result.error);
  assert.equal(result.exit.reason, 'round-limit', result.exit.diagnostic);
  assert.equal(resetCount, 18);
  assert.equal(new Set(sessions).size, 18, 'history objects are replaced, not reused');
  assert.deepEqual(sessions[0].history, ['AMBIENT INSTRUCTIONS AND ANSWER']);
  for (const [path, before] of priorRoundBytes) assert.deepEqual(readFileSync(path), before);
  assert.equal(result.calls.readonly.at(-1), entryReadonly);
  assert.deepEqual(result.calls.notebook, [], 'orchestrator never buffers notebook previews across resets');
  for (const [round, accepted] of outputs) {
    assert.deepEqual(readJSON(join(f.outputPath, `round-${String(round).padStart(4, '0')}.json`)).role_outputs, {
      agenda: accepted.get('agenda'), proposals: VOICES.map((v) => accepted.get(`explore-${v}`)),
      expert: accepted.get('expert'), challenges: VOICES.map((v) => accepted.get(`challenge-${v}`)),
      synthesis: accepted.get('synthesis'),
    });
  }
});

// Reset can fail before or after a runtime changed posture. Cover every slot in
// round one, the next round boundary, and later Expert/Master invocations.
for (const entryReadonly of [false, true]) {
  for (const failAt of [2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 18]) test(`reset ${failAt} fails closed and restores readonly=${entryReadonly}`, () => {
    const f = fixture({ config: { max_rounds: 2 } });
    const result = workflow(f, {
      initialState: { readonly: entryReadonly },
      newStub: ({ state, calls }) => {
        state.readonly = false;
        if (calls.new === failAt) throw new Error(`replacement ${failAt} unavailable`);
      },
    });
    assert.ifError(result.error);
    assert.equal(result.exit.reason, 'failed');
    assert.match(result.exit.phase, /^reset/);
    assert.match(result.exit.diagnostic, new RegExp(`replacement ${failAt} unavailable`));
    assert.equal(result.calls.new, failAt);
    assert.equal(result.calls.run.length, failAt - 1, 'no model call after failed replacement');
    assert.equal(result.calls.readonly.at(-1), entryReadonly);
    const committedRound = failAt > 9 ? 1 : 0;
    assert.equal(result.exit.round, committedRound);
    assert.equal(a.loadSnapshot(result.exit.latest_snapshot).latest.round, committedRound);
    assert.deepEqual(snapshots(f), committedRound ? ['round-0000.json', 'round-0001.json'] : ['round-0000.json']);
    assert.equal(result.checkpoints.filter((c) => c.phase === 'committed').length, committedRound);
    assert.equal(result.shellCalls.filter((c) => operationOf(c.command) === 'finish').length, committedRound);
  });
}

test('midround reset failure resumes from the unchanged complete committed snapshot', () => {
  const f = fixture({ config: { max_rounds: 2 } });
  const failed = workflow(f, { newStub: ({ calls, state }) => {
    state.readonly = false;
    if (calls.new === 14) throw new Error('Expert replacement cancelled');
  } });
  assert.equal(failed.exit.reason, 'failed');
  assert.equal(failed.exit.round, 1);
  const before = readFileSync(failed.exit.latest_snapshot);
  const config = resumeConfig(f, { path: failed.exit.latest_snapshot });
  const resumed = workflow(f, { args: config, runStub: (prompt, options, { calls }) => {
    assert.equal(calls.new, calls.run.length);
    assert.deepEqual(options.input.snapshot, a.projectSnapshot(JSON.parse(before)));
    const slot = turns[(calls.run.length - 1) % 9][2];
    return { output: roleOutput(slot) };
  } });
  healthy(resumed);
  assert.equal(resumed.calls.new, 9);
  assert.equal(resumed.exit.round, 2);
  assert.deepEqual(readFileSync(failed.exit.latest_snapshot), before);
});

for (const phase of ['explore', 'challenge']) for (const voice of VOICES) test(`${phase} ${voice} identity guard rejects a schema-bypassing wrong voice without relabelling`, () => {
  const f = fixture();
  const expectedSlot = `${phase}-${voice}`;
  let submitted;
  const result = workflow(f, { runStub: (prompt, options, { calls }) => {
    const slot = turns[(calls.run.length - 1) % 9][2];
    const output = roleOutput(slot);
    if (slot === expectedSlot) {
      assert.deepEqual(options.output.schema.properties.voice.enum, [voice]);
      output.voice = VOICES.find((v) => v !== voice);
      submitted = clone(output);
    }
    return { output };
  } });
  assert.ifError(result.error);
  assert.equal(result.exit.reason, 'failed');
  assert.match(result.exit.diagnostic, new RegExp(`Participant voice must equal ${voice}`));
  assert.equal(result.calls.run.length, turns.findIndex((t) => t[2] === expectedSlot) + 1);
  assert.equal(result.shellCalls.filter((c) => operationOf(c.command) === 'output-begin').length, result.calls.run.length - 1);
  assert.notEqual(submitted.voice, voice);
  assert.deepEqual(snapshots(f), ['round-0000.json']);
});
