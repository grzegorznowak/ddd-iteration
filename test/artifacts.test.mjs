import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  artifacts as a, SECTION_NAMES, VOICES, ROLE_SLOTS, clone, hash, jsonBytes, readJSON, writeJSON,
  fixture, prepareFixture, event, bundle, roleOutput, stageRound, commitRound, resumeConfig,
  expectError, cli, snapshots, tamper, padJSON,
} from './support.mjs';

// Public CLI and persisted snapshots are checked independently of exported helpers.
test('only control packets and individual chunks retain package size ceilings', () => {
  assert.equal(a.limits.packet, 45 * 1024);
  assert.equal(a.limits.input_chunk, 4000);
  assert.equal(a.limits.output_chunk, 4000);
  for (const key of ['role', 'synthesis', 'artifacts', 'source', 'human_answers', 'config', 'snapshot']) assert.equal(Object.hasOwn(a.limits, key), false);
});

test('CLI start captures exact BOM, CRLF, Unicode, origin and raw SHA-256', () => {
  const source = '\uFEFFOrders accept café ☕.\r\nDispatch\rThird line\n';
  const f = fixture({ source });
  const result = cli('prepare', { config_path: f.configPath }, { cwd: '/' });
  assert.equal(result.status, 0);
  assert.deepEqual(Object.keys(result.packet).sort(), ['data', 'ok']);
  const { latest, input_ref, max_rounds } = result.packet.data;
  assert.equal(Object.hasOwn(result.packet.data, 'snapshot'), false);
  const snapshot = readJSON(input_ref.path);
  assert.equal(hash(readFileSync(input_ref.path)), input_ref.sha256);
  const raw = readFileSync(latest.path);
  const stored = JSON.parse(raw);
  assert.equal(latest.path, join(f.outputPath, 'round-0000.json'));
  assert.equal(latest.round, 0);
  assert.equal(latest.sha256, hash(raw));
  assert.deepEqual(stored.source, { origin: f.sourcePath, text: source, sha256: hash(Buffer.from(source)) });
  assert.equal(stored.previous, null);
  assert.equal(stored.role_outputs, null);
  assert.equal(stored.disposition, 'continue');
  assert.equal(max_rounds, 1);
  assert.deepEqual(stored.human_answers, []);
  assert.deepEqual(Object.keys(stored.artifacts).sort(), [...SECTION_NAMES, 'event_flow', 'open_questions', 'question_resolutions'].sort());
  for (const name of SECTION_NAMES) {
    assert.equal(stored.artifacts[name].status, 'not-modeled');
    assert.ok(stored.artifacts[name].content.trim());
  }
  assert.equal(Object.hasOwn(snapshot, 'role_outputs'), false);
  assert.equal(Object.hasOwn(snapshot, 'previous'), false);
});

test('complete committed round records nine roles, host metadata and previous raw-file hash', () => {
  const f = prepareFixture();
  const initialRaw = readFileSync(f.prepared.latest.path);
  const staged = stageRound(f.prepared);
  const result = cli('finish', { attempt: staged.attempt, output: roleOutput('synthesis') });
  assert.equal(result.status, 0);
  const committed = result.packet.data;
  const raw = readFileSync(committed.latest.path);
  const stored = JSON.parse(raw);
  assert.equal(stored.round, 1);
  assert.deepEqual(stored.previous, { file: 'round-0000.json', sha256: hash(initialRaw) });
  assert.equal(committed.latest.sha256, hash(raw));
  assert.deepEqual(stored.source, readJSON(f.prepared.latest.path).source);
  assert.deepEqual(stored.role_outputs.proposals.map((x) => x.voice), VOICES);
  assert.deepEqual(stored.role_outputs.challenges.map((x) => x.voice), VOICES);
  assert.deepEqual(stored.artifacts, stored.role_outputs.synthesis.artifacts);
  assert.equal(stored.role_outputs.agenda.stage, 'big-picture');
  assert.equal(stored.role_outputs.expert.answers[0].status, 'grounded');
  assert.equal(stored.role_outputs.synthesis.disposition, 'continue');
  assert.deepEqual(readFileSync(f.prepared.latest.path), initialRaw);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
  const loaded = cli('load', { latest: committed.latest });
  assert.equal(loaded.status, 0);
  const projection = readJSON(loaded.packet.data.input_ref.path);
  assert.deepEqual(projection.artifacts, stored.artifacts);
  assert.equal(Object.hasOwn(projection, 'role_outputs'), false);
  assert.equal(Object.hasOwn(projection, 'previous'), false);
});

test('CLI schemas expose strict native object outputs and stable voices', () => {
  const result = cli('schemas');
  assert.equal(result.status, 0);
  assert.deepEqual(Object.keys(result.packet.data).sort(), ['agenda', 'expert', 'participant', 'synthesis']);
  for (const schema of Object.values(result.packet.data)) {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort());
  }
  assert.deepEqual(result.packet.data.participant.properties.voice.enum, VOICES);
});

for (const [name, operation, raw, code] of [
  ['unknown command', 'arbitrary', '{}', 'E_INPUT'],
  ['extra request key', 'schemas', '{"unexpected":1}', 'E_SCHEMA'],
  ['array request', 'schemas', '[]', 'E_SCHEMA'],
  ['malformed JSON', 'schemas', '{', 'E_INPUT'],
  ['two JSON requests', 'schemas', '{}\n{}', 'E_INPUT'],
  ['invalid UTF-8', 'schemas', Buffer.from([0xff]), 'E_INPUT'],
  ['45 KiB input', 'schemas', ' '.repeat(45 * 1024), 'E_SIZE'],
]) test(`CLI rejects ${name} with one error packet`, () => {
  const result = cli(operation, {}, { raw });
  assert.equal(result.status, 1);
  assert.equal(result.packet.ok, false);
  assert.equal(result.packet.error.code, code);
  assert.deepEqual(Object.keys(result.packet).sort(), ['error', 'ok']);
});

test('max_rounds defaults to three; explicit 1 and 8 are accepted', () => {
  for (const cap of [undefined, 1, 8]) {
    const f = fixture();
    writeJSON(f.configPath, { document: 'strategy.md', output: 'artifacts', ...(cap === undefined ? {} : { max_rounds: cap }) });
    assert.equal(a.prepare({ config_path: f.configPath }).max_rounds, cap ?? 3);
  }
});

for (const [name, config] of [
  ['neither mode', {}], ['both modes', { document: 'strategy.md', output: 'artifacts', resume: 'round-0000.json' }],
  ['missing output', { document: 'strategy.md' }], ['resume output', { resume: 'round-0000.json', output: 'elsewhere' }],
  ['start answers', { document: 'strategy.md', output: 'artifacts', answers: 'answers.json' }],
  ['unknown option', { document: 'strategy.md', output: 'artifacts', trusted: true }],
  ['array config', []], ['null config', null],
  ...[0, 9, 1.5, '3', null, true].map((max_rounds) => [`cap ${JSON.stringify(max_rounds)}`, { document: 'strategy.md', output: 'artifacts', max_rounds }]),
]) test(`configuration rejects ${name} without artifacts`, () => {
  const f = fixture();
  writeJSON(f.configPath, config);
  expectError('E_CONFIG', () => a.prepare({ config_path: f.configPath }));
  assert.equal(existsSync(f.outputPath), false);
});

test('configuration accepts raw UTF-8 beyond the former 8 KiB cap', () => {
  const f = fixture();
  const raw = JSON.stringify({ document: 'strategy.md', output: 'artifacts' });
  writeFileSync(f.configPath, raw + ' '.repeat(8 * 1024 - Buffer.byteLength(raw)));
  a.prepare({ config_path: f.configPath });
  const g = fixture();
  writeFileSync(g.configPath, raw + ' '.repeat(8 * 1024 + 1 - Buffer.byteLength(raw)));
  assert.equal(a.prepare({ config_path: g.configPath }).max_rounds, 3);
  assert.equal(existsSync(g.outputPath), true);
});

test('UTF-8 source accepts text beyond the former 12 KiB cap', () => {
  const source = 'é'.repeat(6 * 1024);
  const f = prepareFixture({ source });
  assert.equal(Buffer.byteLength(f.prepared.snapshot.source.text), 12 * 1024);
  assert.equal(f.prepared.snapshot.source.text, source);
  const g = fixture({ source: source + 'é' });
  assert.equal(a.prepare({ config_path: g.configPath }).snapshot.source.text, source + 'é');
});

for (const [name, source, code] of [
  ['empty document', '', 'E_INPUT'], ['invalid UTF-8', Buffer.from([0xc0, 0xaf]), 'E_INPUT'],
]) test(`source rejects ${name} before creating output`, () => {
  const f = fixture({ source });
  expectError(code, () => a.prepare({ config_path: f.configPath }));
  assert.equal(existsSync(f.outputPath), false);
});

test('output must be new and existing evidence is unchanged', () => {
  const f = prepareFixture();
  const before = readFileSync(f.prepared.latest.path);
  expectError('E_INPUT', () => a.prepare({ config_path: f.configPath }), /new directory/);
  assert.deepEqual(readFileSync(f.prepared.latest.path), before);
});

test('nested output parents are supported without adopting output symlinks', () => {
  const f = fixture({ config: { output: 'new parent/nested/artifacts' } });
  const result = a.prepare({ config_path: f.configPath });
  assert.ok(existsSync(result.latest.path));
  const g = fixture();
  mkdirSync(join(g.directory, 'existing'));
  symlinkSync(join(g.directory, 'existing'), g.outputPath);
  expectError('E_INPUT', () => a.prepare({ config_path: g.configPath }));
});

test('role order rejects skipping, duplicates and direct staged synthesis', () => {
  const f = prepareFixture();
  const round = a.begin({ latest: f.prepared.latest, human_answers: [] });
  expectError('E_ORDER', () => a.stage({ attempt: round.attempt, slot: 'expert', output: roleOutput('expert') }));
  a.stage({ attempt: round.attempt, slot: 'agenda', output: roleOutput('agenda') });
  expectError('E_ORDER', () => a.stage({ attempt: round.attempt, slot: 'agenda', output: roleOutput('agenda') }));
  expectError('E_ORDER', () => a.finish({ attempt: round.attempt, output: roleOutput('synthesis') }));
  for (const slot of ROLE_SLOTS.slice(1, -1)) a.stage({ attempt: round.attempt, slot, output: roleOutput(slot) });
  expectError('E_ORDER', () => a.stage({ attempt: round.attempt, slot: 'synthesis', output: roleOutput('synthesis') }));
  assert.deepEqual(snapshots(f), ['round-0000.json']);
});

for (const [name, slot, mutate] of [
  ['wrong stable voice', 'explore-journey', (v) => { v.voice = 'model'; }],
  ['extra role property', 'agenda', (v) => { v.source = { text: 'invented' }; }],
  ['missing role property', 'agenda', (v) => { delete v.focus; }],
  ['invalid agenda stage', 'agenda', (v) => { v.stage = 'approved'; }],
  ['blank string', 'agenda', (v) => { v.focus = '  '; }],
  ['wrong list element', 'explore-model', (v) => { v.dissent = [1]; }],
  ['expert unknown status', 'expert', (v) => { v.answers[0].status = 'certain'; }],
  ['extra synthesis metadata', 'synthesis', (v) => { v.previous = 'invented'; }],
  ['missing replacement section', 'synthesis', (v) => { delete v.artifacts.context_map; }],
  ['missing cumulative question resolutions', 'synthesis', (v) => { delete v.artifacts.question_resolutions; }],
  ['blank not-applicable explanation', 'synthesis', (v) => { v.artifacts.subdomains = { status: 'not-applicable', content: ' ' }; }],
]) test(`role schema rejects ${name}`, () => {
  const f = prepareFixture();
  const value = roleOutput(slot);
  mutate(value);
  expectError('E_SCHEMA', () => a.validateRole(slot, value, f.prepared.snapshot));
});

test('ordinary roles accept UTF-8 and escaped JSON beyond the former 6 KiB cap', () => {
  const f = prepareFixture();
  const base = roleOutput('agenda');
  const exact = padJSON(base, 6 * 1024, (v) => v, 'focus');
  assert.equal(a.validateRole('agenda', exact, f.prepared.snapshot), exact);
  const over = clone(exact);
  over.focus += 'é';
  assert.ok(JSON.stringify(over).length < 7 * 1024);
  assert.equal(a.validateRole('agenda', over, f.prepared.snapshot), over);
  for (const focus of ['é'.repeat(3 * 1024), '\u0001'.repeat(1100)]) {
    const encodedOver = { ...base, focus };
    assert.ok(focus.length < 6 * 1024);
    assert.ok(jsonBytes(encodedOver) > 6 * 1024);
    assert.equal(a.validateRole('agenda', encodedOver, f.prepared.snapshot), encodedOver);
  }
});

test('artifacts and synthesis accept output beyond the former 20 KiB bundle cap', () => {
  const f = prepareFixture();
  const large = padJSON(bundle(), 20 * 1024, (v) => v.shared_understanding, 'content');
  assert.equal(a.validateArtifacts(large, f.prepared.snapshot), large);
  const synthesis = roleOutput('synthesis', { artifacts: large });
  assert.ok(jsonBytes(synthesis) > 6 * 1024);
  assert.ok(jsonBytes(synthesis) < 24 * 1024);
  const committed = commitRound(f.prepared, synthesis).committed;
  assert.equal(jsonBytes(readJSON(committed.latest.path).artifacts), 20 * 1024);
  assert.equal(a.loadSnapshot(committed.latest.path).snapshot.artifacts.shared_understanding.content, large.shared_understanding.content);
  const over = clone(large);
  over.shared_understanding.content += 'é';
  assert.equal(a.validateArtifacts(over, f.prepared.snapshot), over);
  const multibyteOver = bundle();
  multibyteOver.shared_understanding.content = 'é'.repeat(10 * 1024);
  assert.ok(JSON.stringify(multibyteOver).length < 20 * 1024);
  assert.equal(a.validateArtifacts(multibyteOver, f.prepared.snapshot), multibyteOver);
});

test('synthesis accepts output beyond the former 24 KiB UTF-8 JSON cap', () => {
  const f = prepareFixture();
  const exact = padJSON(roleOutput('synthesis'), 24 * 1024);
  assert.equal(a.validateRole('synthesis', exact, f.prepared.snapshot), exact);
  const over = clone(exact);
  over.rationale += 'é';
  assert.equal(a.validateRole('synthesis', over, f.prepared.snapshot), over);
  const multibyteOver = roleOutput('synthesis');
  multibyteOver.rationale = 'é'.repeat(12 * 1024);
  assert.ok(JSON.stringify(multibyteOver).length < 24 * 1024);
  assert.equal(a.validateRole('synthesis', multibyteOver, f.prepared.snapshot), multibyteOver);
});

test('full stored-snapshot validation has no independent byte cap', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared).committed;
  const value = readJSON(first.latest.path);
  value.artifacts = padJSON(bundle(), 20 * 1024, (v) => v.shared_understanding, 'content');
  value.role_outputs.synthesis = roleOutput('synthesis', { artifacts: clone(value.artifacts) });
  value.rationale = value.role_outputs.synthesis.rationale;
  // Combine escaped source with role outputs at the former boundaries. Stored
  // snapshots still accept complete data beyond their former independent cap.
  value.source.text = '\u0001'.repeat(6000);
  value.source.sha256 = hash(value.source.text);
  value.role_outputs.agenda = padJSON(value.role_outputs.agenda, 6 * 1024, (v) => v, 'focus');
  value.role_outputs.expert = padJSON(value.role_outputs.expert, 6 * 1024, (v) => v.answers[0], 'answer');
  for (const roles of [value.role_outputs.proposals, value.role_outputs.challenges]) {
    for (let index = 0; index < roles.length; index++) roles[index] = padJSON(roles[index], 6 * 1024, (v) => v.observations, 0);
  }
  let remaining = 128 * 1024 - jsonBytes(value);
  if (remaining % 2 !== 0) { value.role_outputs.agenda.focus = value.role_outputs.agenda.focus.slice(0, -1); remaining++; }
  assert.ok(remaining >= 0);
  value.role_outputs.synthesis.rationale += 'x'.repeat(remaining / 2);
  value.rationale = value.role_outputs.synthesis.rationale;
  assert.equal(jsonBytes(value), 128 * 1024);
  assert.equal(a.validateSnapshot(value), value);
  value.source.origin += 'x';
  assert.equal(jsonBytes(value), 128 * 1024 + 1);
  assert.equal(a.validateSnapshot(value), value);
});

for (const [name, evidence, status, valid] of [
  ['single source line', ['source:L1'], 'grounded', true],
  ['source range', ['source:L1-L2'], 'grounded', true],
  ['CRLF final line', ['source:L3'], 'grounded', true],
  ['grounded without evidence', [], 'grounded', false],
  ['hypothesis without evidence', [], 'hypothesis', true],
  ['unknown without evidence', [], 'unknown', true],
  ['out-of-bounds line', ['source:L4'], 'grounded', false],
  ['reversed range', ['source:L2-L1'], 'grounded', false],
  ['line zero', ['source:L0'], 'grounded', false],
  ['open-ended range', ['source:L1-'], 'grounded', false],
  ['external citation', ['https://example.com/fact'], 'hypothesis', false],
  ['invented answer revision', ['human:Q1:r1'], 'grounded', false],
]) test(`expert evidence: ${name}`, () => {
  const f = prepareFixture();
  const value = roleOutput('expert');
  Object.assign(value.answers[0], { evidence, status });
  if (valid) assert.equal(a.validateRole('expert', value, f.prepared.snapshot), value);
  else expectError('E_EVIDENCE', () => a.validateRole('expert', value, f.prepared.snapshot));
});

test('event evidence is checked independently of expert output', () => {
  const f = prepareFixture();
  for (const [confidence, evidence, valid] of [['grounded', [], false], ['hypothesis', [], true], ['hypothesis', ['source:L99'], false]]) {
    const value = bundle();
    Object.assign(value.event_flow.events[0], { confidence, evidence });
    if (valid) a.validateArtifacts(value, f.prepared.snapshot);
    else expectError('E_EVIDENCE', () => a.validateArtifacts(value, f.prepared.snapshot));
  }
});

for (const [name, mutate, code] of [
  ['duplicate event IDs', (v) => { v.event_flow.events.push(event()); }, 'E_EVENT_FLOW'],
  ['unknown relation endpoint', (v) => { v.event_flow.relations.push({ from: 'E1', to: 'E9', kind: 'precedes', note: 'Unproved' }); }, 'E_EVENT_FLOW'],
  ['self relation', (v) => { v.event_flow.relations.push({ from: 'E1', to: 'E1', kind: 'parallel', note: 'Self' }); }, 'E_EVENT_FLOW'],
  ['strict cycle', (v) => { v.event_flow.events.push(event('E2')); v.event_flow.relations.push({ from: 'E1', to: 'E2', kind: 'precedes', note: 'Before' }, { from: 'E2', to: 'E1', kind: 'causes', note: 'Back' }); }, 'E_EVENT_FLOW'],
  ['duplicate question IDs', (v) => { v.open_questions.push({ id: 'Q1', question: 'A', blocking: false }, { id: 'Q1', question: 'B', blocking: true }); }, 'E_SCHEMA'],
  ['invalid event ID', (v) => { v.event_flow.events[0].id = 'not an ID'; }, 'E_SCHEMA'],
]) test(`artifact validation rejects ${name}`, () => {
  const f = prepareFixture();
  const value = bundle();
  mutate(value);
  expectError(code, () => a.validateArtifacts(value, f.prepared.snapshot));
});

test('partial order permits parallel/alternative back edges and duplicate strict edges', () => {
  const f = prepareFixture();
  const value = bundle();
  value.event_flow.events.push(event('E2'), event('E3'));
  value.event_flow.relations = [
    { from: 'E1', to: 'E2', kind: 'precedes', note: 'Before' },
    { from: 'E1', to: 'E2', kind: 'causes', note: 'Same strict edge' },
    { from: 'E2', to: 'E1', kind: 'parallel', note: 'Not a strict edge' },
    { from: 'E2', to: 'E1', kind: 'alternative', note: 'Branch' },
  ];
  assert.equal(a.validateArtifacts(value, f.prepared.snapshot), value);
});

for (const disposition of ['continue', 'candidate', 'needs-human']) test(`blocking question forces needs-human from ${disposition}`, () => {
  const f = prepareFixture();
  const synthesis = roleOutput('synthesis', { artifacts: bundle({ question: true }), disposition });
  const result = commitRound(f.prepared, synthesis).committed;
  const stored = readJSON(result.latest.path);
  assert.equal(result.disposition, 'needs-human');
  assert.equal(stored.disposition, 'needs-human');
  assert.match(stored.rationale, /Q1/);
  assert.equal(stored.role_outputs.synthesis.disposition, disposition);
});

for (const [name, value, expected] of [
  ['fully modeled', bundle(), 'candidate'],
  ['no events', bundle({ events: false }), 'continue'],
  ['not modeled sections', bundle({ modeled: false }), 'continue'],
  ['justified not-applicable sections', (() => { const v = bundle(); for (const name of SECTION_NAMES) v[name] = { status: 'not-applicable', content: 'Outside the explicit workshop scope.' }; return v; })(), 'candidate'],
]) test(`candidate readiness: ${name}`, () => {
  const result = a.deriveDisposition(roleOutput('synthesis', { artifacts: value, disposition: 'candidate' }));
  assert.equal(result.disposition, expected);
});

test('resume needs no original source, records human revisions and never rewrites prior snapshots', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const initialRaw = readFileSync(f.prepared.latest.path);
  const firstRaw = readFileSync(first.latest.path);
  // Move the newly created input instead of removing it. Its recorded origin is now unavailable.
  renameSync(f.sourcePath, join(f.directory, 'source-retained-but-not-at-origin.md'));
  assert.equal(existsSync(f.sourcePath), false);
  const config1 = resumeConfig(f, first.latest, { answers: [{ question_id: 'Q1', answer: 'Operations can cancel.' }], name: 'resume1.json' });
  const prepared1 = a.prepare({ config_path: config1 });
  assert.deepEqual(prepared1.snapshot.human_answers, [{ question_id: 'Q1', question: 'Who can cancel an order?', answer: 'Operations can cancel.', revision: 1, attribution: 'human' }]);
  assert.equal(prepared1.snapshot.source.text, f.prepared.snapshot.source.text);
  const synthesis = roleOutput('synthesis', { artifacts: bundle({ question: true }) });
  const second = commitRound(prepared1, synthesis).committed;
  assert.equal(second.disposition, 'needs-human', 'A human answer does not automatically close a blocker');
  const config2 = resumeConfig(f, second.latest, { answers: [{ question_id: 'Q1', answer: 'Only the operations lead can cancel.' }], name: 'resume2.json' });
  const prepared2 = a.prepare({ config_path: config2 });
  assert.deepEqual(prepared2.snapshot.human_answers.map((row) => [row.revision, row.attribution, row.answer]), [
    [1, 'human', 'Operations can cancel.'], [2, 'human', 'Only the operations lead can cancel.'],
  ]);
  const expert = roleOutput('expert');
  expert.answers[0].evidence = ['human:Q1:r1', 'human:Q1:r2'];
  a.validateRole('expert', expert, prepared2.snapshot);
  expert.answers[0].evidence = ['human:Q1:r3'];
  expectError('E_EVIDENCE', () => a.validateRole('expert', expert, prepared2.snapshot));
  const third = commitRound(prepared2, synthesis).committed;
  assert.equal(readJSON(third.latest.path).human_answers.length, 2);
  assert.deepEqual(readFileSync(f.prepared.latest.path), initialRaw);
  assert.deepEqual(readFileSync(first.latest.path), firstRaw);
});

for (const [name, answers, code] of [
  ['unknown question', [{ question_id: 'Q9', answer: 'A' }], 'E_INPUT'],
  ['duplicate question', [{ question_id: 'Q1', answer: 'A' }, { question_id: 'Q1', answer: 'B' }], 'E_INPUT'],
  ['non-array answers', { Q1: 'A' }, 'E_INPUT'],
  ['model attribution field', [{ question_id: 'Q1', answer: 'A', attribution: 'human' }], 'E_SCHEMA'],
  ['empty answer', [{ question_id: 'Q1', answer: ' ' }], 'E_SCHEMA'],
  ['invalid identifier', [{ question_id: 'Q 1', answer: 'A' }], 'E_SCHEMA'],
]) test(`resume rejects ${name} and preserves the base`, () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const before = readFileSync(first.latest.path);
  const config = resumeConfig(f, first.latest, { answers });
  expectError(code, () => a.prepare({ config_path: config }));
  assert.deepEqual(readFileSync(first.latest.path), before);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

test('cumulative human-answer JSON and revisions can exceed the former cap, including UTF-8', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const row = { question_id: 'Q1', question: 'Who can cancel an order?', answer: 'é', revision: 1, attribution: 'human' };
  row.answer += 'x'.repeat(4 * 1024 - jsonBytes([row]));
  assert.equal(jsonBytes([row]), 4 * 1024);
  const config = resumeConfig(f, first.latest, { answers: [{ question_id: 'Q1', answer: row.answer }] });
  const prepared = a.prepare({ config_path: config });
  assert.equal(jsonBytes(prepared.snapshot.human_answers), 4 * 1024);
  const second = commitRound(prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const revised = resumeConfig(f, second.latest, { answers: [{ question_id: 'Q1', answer: 'New revision' }], name: 'too-many.json' });
  assert.equal(a.prepare({ config_path: revised }).snapshot.human_answers.length, 2);
  const oversizeInput = resumeConfig(f, second.latest, { answers: [{ question_id: 'Q1', answer: 'é'.repeat(3 * 1024) }], name: 'raw-too-large.json' });
  assert.equal(a.prepare({ config_path: oversizeInput }).snapshot.human_answers[1].answer, 'é'.repeat(3 * 1024));
});

test('exclusive concurrent attempts choose one round and refuse stale resume without overwrite', () => {
  const f = prepareFixture();
  const firstAttempt = stageRound(f.prepared);
  const secondAttempt = stageRound(f.prepared);
  const winner = firstAttempt.finish();
  const raw = readFileSync(winner.latest.path);
  expectError('E_STALE', () => secondAttempt.finish());
  expectError('E_STALE', () => a.loadSnapshot(f.prepared.latest.path));
  expectError('E_STALE', () => a.prepare({ config_path: resumeConfig(f, f.prepared.latest) }));
  assert.deepEqual(readFileSync(winner.latest.path), raw);
  assert.deepEqual(snapshots(f), ['round-0000.json', 'round-0001.json']);
});

test('forged existing destination is never overwritten', () => {
  const f = prepareFixture();
  const attempt = stageRound(f.prepared);
  const destination = join(f.outputPath, 'round-0001.json');
  const marker = 'pre-existing evidence: not a complete snapshot';
  writeFileSync(destination, marker, { flag: 'wx' });
  expectError('E_STALE', () => attempt.finish());
  assert.equal(readFileSync(destination, 'utf8'), marker);
});

for (const [name, mutate, code] of [
  ['source text/hash mismatch', (v) => { v.source.text += 'tampered'; }, 'E_LINEAGE'],
  ['host round changed', (v) => { v.round = 7; }, 'E_LINEAGE'],
  ['previous hash', (v) => { v.previous.sha256 = '0'.repeat(64); }, 'E_LINEAGE'],
  ['artifact/synthesis mismatch', (v) => { v.artifacts.decisions.content += 'changed'; }, 'E_LINEAGE'],
  ['gate disposition tampering', (v) => { v.disposition = 'candidate'; }, 'E_LINEAGE'],
  ['role voice tampering', (v) => { v.role_outputs.proposals[0].voice = 'model'; }, 'E_SCHEMA'],
  ['extra metadata', (v) => { v.approval = true; }, 'E_SCHEMA'],
]) test(`resume detects ${name}`, () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared).committed;
  tamper(first.latest.path, mutate);
  expectError(code, () => a.loadSnapshot(first.latest.path));
});

test('resume detects a modified ancestor even if the current snapshot is untouched', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared).committed;
  tamper(f.prepared.latest.path, (v) => { v.rationale += 'tampered ancestor'; });
  expectError('E_LINEAGE', () => a.loadSnapshot(first.latest.path), /hash mismatch/);
});

test('lineage rejects source-origin drift even with internally valid source hashes', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared).committed;
  tamper(first.latest.path, (v) => { v.source.origin = join(f.directory, 'different-source.md'); });
  expectError('E_LINEAGE', () => a.loadSnapshot(first.latest.path), /Source content, origin, or hash changed/);
});

test('expected latest hash, round and path cannot be substituted', () => {
  const f = prepareFixture();
  for (const latest of [
    { ...f.prepared.latest, sha256: '0'.repeat(64) },
    { ...f.prepared.latest, round: 1 },
    { ...f.prepared.latest, path: join(f.directory, 'round-0000.json') },
  ]) assert.throws(() => a.dispatch('load', { latest }));
});

test('pending answers cannot alter or skip historical revisions', () => {
  const f = prepareFixture();
  const first = commitRound(f.prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const prepared = a.prepare({ config_path: resumeConfig(f, first.latest, { answers: [{ question_id: 'Q1', answer: 'A' }] }) });
  const second = commitRound(prepared, roleOutput('synthesis', { artifacts: bundle({ question: true }) })).committed;
  const loaded = a.loadSnapshot(second.latest.path);
  for (const answers of [[], [{ ...loaded.snapshot.human_answers[0], answer: 'rewritten' }], [...loaded.snapshot.human_answers, { question_id: 'Q1', question: 'Who can cancel an order?', answer: 'B', revision: 3, attribution: 'human' }]]) {
    expectError('E_LINEAGE', () => a.begin({ latest: loaded.latest, human_answers: answers }));
  }
});

test('draft directories cannot be resumed; inspect/recover return only validated durable refs', () => {
  const f = prepareFixture();
  const attempt = stageRound(f.prepared);
  expectError('E_LINEAGE', () => a.loadSnapshot(join(attempt.attempt, 'attempt.json')));
  assert.deepEqual(a.recover({ attempt: attempt.attempt }).latest, f.prepared.latest);
  assert.deepEqual(a.inspect({ config_path: f.configPath }).latest, f.prepared.latest);
  const committed = attempt.finish();
  assert.deepEqual(a.recover({ attempt: attempt.attempt }).latest, committed.latest);
  assert.deepEqual(a.inspect({ config_path: f.configPath }).latest, committed.latest);
});

test('leaf snapshot symlinks are refused rather than read as committed evidence', () => {
  const f = prepareFixture();
  const moved = join(f.outputPath, 'retained-initial.json');
  renameSync(f.prepared.latest.path, moved);
  symlinkSync(moved, f.prepared.latest.path);
  assert.throws(() => a.loadSnapshot(f.prepared.latest.path));
  assert.equal(basename(f.prepared.latest.path), 'round-0000.json');
});
