#!/usr/bin/env node
// Deterministic artifact mechanics only. No model calls and no external packages.
// All CLI requests/replies are single JSON packets on stdin/stdout. Hidden attempt
// directories are incomplete drafts, never resume points. Nothing is deleted.
import {
  constants, openSync, closeSync, readSync, readFileSync, writeFileSync, fstatSync, fsyncSync,
  fchmodSync, lstatSync, realpathSync, mkdirSync, linkSync, readdirSync, existsSync, renameSync, chmodSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const limits = Object.freeze({
  packet: 45 * 1024, input_chunk: 4000, output_chunk: 4000,
});
export const sections = Object.freeze([
  'shared_understanding', 'ubiquitous_language', 'subdomains', 'process_model',
  'rules_and_aggregates', 'bounded_contexts', 'context_map', 'architecture_candidates',
  'stressor_analysis', 'assumptions', 'decisions', 'change_log',
]);
export const voices = Object.freeze(['journey', 'model', 'stressor']);
export const slots = Object.freeze([
  'agenda', 'explore-journey', 'explore-model', 'explore-stressor', 'expert',
  'challenge-journey', 'challenge-model', 'challenge-stressor', 'synthesis',
]);
const version = 1;
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
const object = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: string };
const identifier = { ...string, pattern: idPattern };
const sectionSchema = object({ status: { enum: ['modeled', 'not-modeled', 'not-applicable'] }, content: string });
const evidenceSchema = {
  type: 'array', items: {
    ...string,
    description: 'A checked source:L1 or source:L1-L3 reference, or human:Q1:r1 (explicit answer revision).',
  },
};
const artifactProperties = Object.fromEntries(sections.map((name) => [name, sectionSchema]));
artifactProperties.event_flow = object({
  events: { type: 'array', items: object({
    id: identifier, name: string, actor: string, scenario: string,
    evidence: evidenceSchema, confidence: { enum: ['grounded', 'hypothesis'] },
  }) },
  relations: { type: 'array', items: object({
    from: identifier, to: identifier,
    kind: { enum: ['precedes', 'causes', 'alternative', 'parallel'] }, note: string,
  }) },
  hotspots: strings,
});
artifactProperties.open_questions = { type: 'array', items: object({
  id: identifier, question: string, blocking: { type: 'boolean' },
}) };
artifactProperties.question_resolutions = { type: 'array', items: object({
  question_id: identifier, question: string, resolution: string,
  evidence: { ...evidenceSchema, minItems: 1 },
}) };
export const schemas = {
  agenda: object({ focus: string, stage: { enum: ['big-picture', 'process', 'design'] }, questions: strings }),
  participant: object({ voice: { enum: [...voices] }, observations: strings, proposals: strings, questions: strings, dissent: strings }),
  expert: object({
    answers: { type: 'array', items: object({
      question: string, answer: string, evidence: evidenceSchema,
      status: { enum: ['grounded', 'hypothesis', 'unknown'] },
    }) }, unresolved: strings,
  }),
  synthesis: object({ artifacts: object(artifactProperties), disposition: { enum: ['continue', 'needs-human', 'candidate'] }, rationale: string }),
};

export class ArtifactError extends Error {
  constructor(code, message) { super(message); this.name = 'ArtifactError'; this.code = code; }
}
function fail(code, message) { throw new ArtifactError(code, message); }
function isResourceError(error) {
  return error instanceof RangeError || ['ENOMEM', 'ERR_FS_FILE_TOO_LARGE', 'ERR_STRING_TOO_LONG', 'ERR_OUT_OF_RANGE'].includes(error.code);
}
function resourceFailure(error) {
  fail('E_RESOURCE', `Host resource limit prevented complete input/output processing; no partial data was accepted: ${error.message || error}`);
}
function assert(condition, code, message) { if (!condition) fail(code, message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, required, optional = [], label = 'object') {
  assert(isObject(value), 'E_SCHEMA', `${label} must be an object.`);
  for (const key of required) assert(Object.hasOwn(value, key), 'E_SCHEMA', `${label}.${key} is required.`);
  for (const key of Object.keys(value)) assert(required.includes(key) || optional.includes(key), 'E_SCHEMA', `${label}.${key} is not allowed.`);
}
function text(value, label) { assert(typeof value === 'string' && value.trim().length > 0, 'E_SCHEMA', `${label} must be a nonempty string.`); }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function encoded(value) {
  let result;
  try { result = JSON.stringify(value); } catch (error) {
    if (isResourceError(error)) resourceFailure(error);
    fail('E_SCHEMA', 'Value must be JSON serializable.');
  }
  assert(typeof result === 'string', 'E_SCHEMA', 'Value must be JSON serializable.');
  return result;
}
function packet(value) {
  const result = encoded(value) + '\n';
  assert(Buffer.byteLength(result, 'utf8') < limits.packet, 'E_SIZE', 'Shell control packet must be below 45 KiB; use chunked input/output transport for domain data.');
  return result;
}
function pathText(value, label) {
  text(value, label);
  assert(!value.includes('\0'), 'E_INPUT', `${label} must be a path without NUL.`);
  return value;
}
function checkSchema(value, schema, label) {
  if (schema.enum) assert(schema.enum.includes(value), 'E_SCHEMA', `${label} must be one of ${schema.enum.join(', ')}.`);
  if (schema.type === 'object') {
    exactKeys(value, schema.required, [], label);
    for (const [key, child] of Object.entries(schema.properties)) checkSchema(value[key], child, `${label}.${key}`);
  } else if (schema.type === 'array') {
    assert(Array.isArray(value), 'E_SCHEMA', `${label} must be an array.`);
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, 'E_EVIDENCE', `${label} needs at least ${schema.minItems} reference(s).`);
    for (let index = 0; index < value.length; index++) checkSchema(value[index], schema.items, `${label}[${index}]`);
  } else if (schema.type === 'string') {
    text(value, label);
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value), 'E_SCHEMA', `${label} has an invalid identifier.`);
  } else if (schema.type === 'boolean') {
    assert(typeof value === 'boolean', 'E_SCHEMA', `${label} must be boolean.`);
  }
}
function canonicalDirectory(path) {
  const result = realpathSync(path);
  assert(lstatSync(result).isDirectory(), 'E_INPUT', `${path} must be a directory.`);
  return result;
}
function canonicalFilePath(path) { return join(canonicalDirectory(dirname(resolve(path))), basename(path)); }
function newOutputPath(requested) {
  assert(!existsSync(requested), 'E_INPUT', 'Output must be a new directory; existing evidence is never overwritten.');
  const pending = [basename(requested)];
  let parent = dirname(requested);
  while (!existsSync(parent)) { pending.unshift(basename(parent)); parent = dirname(parent); }
  return join(canonicalDirectory(parent), ...pending);
}
function createOutputDirectory(output) {
  const pending = [];
  let parent = dirname(output);
  while (!existsSync(parent)) { pending.push(parent); parent = dirname(parent); }
  for (const directory of pending.reverse()) {
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
      // A concurrent ordinary parent creation is harmless. Never adopt a new
      // symlink or overwrite a non-directory while creating the explicit path.
      if (error.code !== 'EEXIST' || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw error;
    }
    syncDirectory(dirname(directory));
  }
  mkdirSync(output, { mode: 0o700 });
  syncDirectory(dirname(output));
}
function readBytes(path, maximum, label) {
  // O_NOFOLLOW closes the leaf symlink race where supported. We do not claim to
  // defend against a hostile process replacing parent directories or hardlinks.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile(), 'E_INPUT', `${label} must be a regular file.`);
    // Domain inputs have no package byte ceiling. Node/OS memory and string
    // limits still apply; never return a partial read on resource exhaustion.
    if (maximum === null) return readFileSync(fd);
    assert(stat.size <= maximum, 'E_SIZE', `${label} exceeds ${maximum} bytes.`);
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    assert(length <= maximum, 'E_SIZE', `${label} exceeds ${maximum} bytes.`);
    return buffer.subarray(0, length);
  } catch (error) {
    if (isResourceError(error)) resourceFailure(error);
    throw error;
  } finally { closeSync(fd); }
}
function decode(buffer, label) {
  try {
    // Keep a UTF-8 BOM as part of the exact source text and its hash.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch (error) {
    if (isResourceError(error)) resourceFailure(error);
    fail('E_INPUT', `${label} must be valid UTF-8.`);
  }
}
function readJson(path, maximum, label) {
  const raw = readBytes(path, maximum, label);
  let value;
  try { value = JSON.parse(decode(raw, label)); } catch (error) {
    if (error instanceof ArtifactError) throw error;
    if (isResourceError(error)) resourceFailure(error);
    fail('E_INPUT', `${label} must contain valid JSON.`);
  }
  return { value, raw };
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeExclusive(path, raw) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, raw);
    // Snapshots and drafts are evidence, not mutable work files.
    fchmodSync(fd, 0o444);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function writeReplace(path, raw) {
  // Atomic overwrite for redo/stale replacement; the draft stays hidden until rename.
  const draft = path + '.draft-' + randomUUID();
  const fd = openSync(draft, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(draft, path);
  chmodSync(path, 0o444);
  syncDirectory(dirname(path));
}
function roundFile(round) {
  assert(Number.isSafeInteger(round) && round >= 0, 'E_SCHEMA', 'Round must be a nonnegative safe integer.');
  return `round-${String(round).padStart(4, '0')}.json`;
}
function roundOfFile(file) {
  if (!/^round-\d{4,}\.json$/.test(file)) return null;
  const round = Number(file.slice(6, -5));
  return Number.isSafeInteger(round) && roundFile(round) === file ? round : null;
}
function validateLatest(latest) {
  exactKeys(latest, ['path', 'sha256', 'round'], [], 'latest');
  pathText(latest.path, 'latest.path');
  assert(hashPattern.test(latest.sha256), 'E_SCHEMA', 'latest.sha256 must be SHA-256.');
  roundFile(latest.round);
  assert(basename(latest.path) === roundFile(latest.round), 'E_SCHEMA', 'Latest filename must match its round.');
}
function sameLatest(expected, actual) {
  validateLatest(expected);
  assert(canonicalFilePath(expected.path) === actual.path && expected.sha256 === actual.sha256 && expected.round === actual.round,
    'E_LINEAGE', 'The expected snapshot path, hash, or round does not match stored evidence.');
}
function validateSource(source) {
  exactKeys(source, ['origin', 'text', 'sha256'], [], 'source');
  pathText(source.origin, 'source.origin');
  assert(typeof source.text === 'string', 'E_SCHEMA', 'source.text must be a string.');
  const raw = Buffer.from(source.text, 'utf8');
  assert(raw.length > 0, 'E_INPUT', 'Strategic document must not be empty.');
  assert(hashPattern.test(source.sha256) && sha256(raw) === source.sha256, 'E_LINEAGE', 'Source text/hash mismatch.');
}
function validateHumanAnswers(answers) {
  assert(Array.isArray(answers), 'E_SCHEMA', 'human_answers must be an array.');
  const revisions = new Map();
  const knownQuestions = new Map();
  for (const [index, row] of answers.entries()) {
    const label = `human_answers[${index}]`;
    exactKeys(row, ['question_id', 'question', 'answer', 'revision', 'attribution'], [], label);
    checkSchema(row.question_id, identifier, `${label}.question_id`);
    text(row.question, `${label}.question`);
    bindQuestion(knownQuestions, row.question_id, row.question);
    text(row.answer, `${label}.answer`);
    assert(row.attribution === 'human', 'E_SCHEMA', `${label}.attribution must be human.`);
    assert(row.revision === (revisions.get(row.question_id) || 0) + 1, 'E_LINEAGE', `${label}.revision is not the next answer revision.`);
    revisions.set(row.question_id, row.revision);
  }
}
function lineCount(source) { return source.text.split(/\r\n|\n|\r/).length; }
function checkEvidence(evidence, snapshot, required, label) {
  // These checks establish that references exist. They cannot establish whether
  // the cited source or human answer supports a claimed event or resolution.
  assert(!required || evidence.length > 0, 'E_EVIDENCE', `${label} needs at least one source-line or human-answer reference.`);
  for (const reference of evidence) {
    const source = /^source:L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(reference);
    if (source) {
      const first = Number(source[1]);
      const last = Number(source[2] || source[1]);
      assert(Number.isSafeInteger(last) && first <= last && last <= lineCount(snapshot.source), 'E_EVIDENCE', `${label}: ${reference} is outside the source.`);
      continue;
    }
    const human = /^human:([A-Za-z][A-Za-z0-9_-]{0,63}):r([1-9]\d*)$/.exec(reference);
    assert(human && snapshot.human_answers.some((row) => row.question_id === human[1] && row.revision === Number(human[2])),
      'E_EVIDENCE', `${label}: ${reference} is not a source:Lx[-Ly] or existing human:question_id:rN reference.`);
  }
}
export function emptyArtifacts() {
  const result = Object.fromEntries(sections.map((name) => [name, {
    status: 'not-modeled', content: 'Not modeled yet: the initial strategic source has been captured; workshop analysis has not started.',
  }]));
  result.event_flow = { events: [], relations: [], hotspots: [] };
  result.open_questions = [];
  result.question_resolutions = [];
  return result;
}
export function validateArtifacts(artifacts, snapshot) {
  checkSchema(artifacts, schemas.synthesis.properties.artifacts, 'artifacts');
  const ids = new Set();
  const edges = new Map();
  const indegrees = new Map();
  for (const event of artifacts.event_flow.events) {
    assert(!ids.has(event.id), 'E_EVENT_FLOW', `Duplicate event ID ${event.id}.`);
    ids.add(event.id); edges.set(event.id, new Set()); indegrees.set(event.id, 0);
    if (snapshot) checkEvidence(event.evidence, snapshot, event.confidence === 'grounded', `event ${event.id}.evidence`);
  }
  for (const relation of artifacts.event_flow.relations) {
    assert(ids.has(relation.from) && ids.has(relation.to), 'E_EVENT_FLOW', `Relation ${relation.from} -> ${relation.to} refers to an unknown event.`);
    assert(relation.from !== relation.to, 'E_EVENT_FLOW', `Event ${relation.from} cannot link to itself.`);
    if (relation.kind === 'precedes' || relation.kind === 'causes') {
      const outgoing = edges.get(relation.from);
      if (!outgoing.has(relation.to)) {
        outgoing.add(relation.to);
        indegrees.set(relation.to, indegrees.get(relation.to) + 1);
      }
    }
  }
  const ready = [...ids].filter((id) => indegrees.get(id) === 0);
  let visited = 0;
  for (let index = 0; index < ready.length; index++) {
    visited++;
    for (const to of edges.get(ready[index])) {
      indegrees.set(to, indegrees.get(to) - 1);
      if (indegrees.get(to) === 0) ready.push(to);
    }
  }
  assert(visited === ids.size, 'E_EVENT_FLOW', 'Strict precedence/causality relations contain a cycle.');
  const questionIds = new Set();
  const questionTexts = new Set();
  const knownQuestions = new Map();
  for (const question of artifacts.open_questions) {
    assert(!questionIds.has(question.id), 'E_SCHEMA', `Duplicate question ID ${question.id}.`);
    questionIds.add(question.id);
    const normalized = question.question.replace(/\s+/g, ' ').trim().toLowerCase();
    assert(!questionTexts.has(normalized), 'E_SCHEMA', 'Verbatim duplicate question text within one synthesis is rejected.');
    questionTexts.add(normalized);
    bindQuestion(knownQuestions, question.id, question.question);
  }
  for (const [index, row] of artifacts.question_resolutions.entries()) {
    bindQuestion(knownQuestions, row.question_id, row.question);
    if (snapshot) checkEvidence(row.evidence, snapshot, true, `question_resolutions[${index}].evidence`);
  }
  return artifacts;
}
function bindQuestion(knownQuestions, id, question) {
  assert(!knownQuestions.has(id) || knownQuestions.get(id) === question,
    'E_LINEAGE', `Question ID ${id} must keep its original exact question wording.`);
  knownQuestions.set(id, question);
}
function validateQuestionTransition(previous, artifacts, knownQuestions = new Map()) {
  const history = previous?.question_resolutions || [];
  const resolutions = artifacts.question_resolutions;
  assert(resolutions.length >= history.length && history.every((row, index) => {
    const next = resolutions[index];
    return next.question_id === row.question_id && next.question === row.question && next.resolution === row.resolution && encoded(next.evidence) === encoded(row.evidence);
  }), 'E_LINEAGE', 'Question resolution history must preserve every prior record unchanged and in order.');
  for (const question of previous?.open_questions || []) bindQuestion(knownQuestions, question.id, question.question);
  for (const row of history) bindQuestion(knownQuestions, row.question_id, row.question);
  for (const question of artifacts.open_questions) bindQuestion(knownQuestions, question.id, question.question);
  for (const row of resolutions) bindQuestion(knownQuestions, row.question_id, row.question);
  const open = new Map(artifacts.open_questions.map((question) => [question.id, question]));
  const resolvedNow = new Set(resolutions.slice(history.length).map((row) => row.question_id));
  for (const question of previous?.open_questions || []) {
    const current = open.get(question.id);
    assert(current || resolvedNow.has(question.id), 'E_LINEAGE',
      `Removed open question ${question.id} requires a new evidence-backed resolution record with its exact question wording.`);
    assert(!question.blocking || !current || current.blocking || resolvedNow.has(question.id), 'E_LINEAGE',
      `Demoting blocking question ${question.id} requires a new evidence-backed resolution record explaining the remaining nonblocking uncertainty.`);
  }
  return knownQuestions;
}
export function validateRole(slot, output, snapshot) {
  assert(slots.includes(slot), 'E_SCHEMA', `Unknown role slot ${slot}.`);
  const kind = slot === 'agenda' || slot === 'expert' || slot === 'synthesis' ? slot : 'participant';
  checkSchema(output, schemas[kind], slot);
  if (kind === 'participant') {
    assert(output.voice === slot.slice(slot.indexOf('-') + 1), 'E_SCHEMA', `Role ${slot} returned the wrong stable voice.`);
  } else if (kind === 'expert') {
    for (const [index, answer] of output.answers.entries()) {
      checkEvidence(answer.evidence, snapshot, answer.status === 'grounded', `expert.answers[${index}].evidence`);
    }
  } else if (kind === 'synthesis') {
    assert(isObject(snapshot) && isObject(snapshot.artifacts), 'E_INPUT', 'Synthesis validation requires the prior snapshot.');
    validateArtifacts(output.artifacts, snapshot);
    validateQuestionTransition(snapshot.artifacts, output.artifacts);
  }
  return output;
}
export function deriveDisposition(synthesis) {
  let disposition = synthesis.disposition;
  let rationale = synthesis.rationale;
  const blockers = synthesis.artifacts.open_questions.filter((question) => question.blocking);
  if (blockers.length) {
    disposition = 'needs-human';
    rationale += `\nHost gate: blocking questions remain (${blockers.map((question) => question.id).join(', ')}); human input is required.`;
  } else if (disposition === 'candidate') {
    const missing = sections.filter((name) => synthesis.artifacts[name].status === 'not-modeled');
    if (!synthesis.artifacts.event_flow.events.length || missing.length) {
      disposition = 'continue';
      rationale += '\nHost gate: candidate readiness is incomplete; business events and every named section must be modeled or justified not-applicable.';
    }
  }
  return { disposition, rationale };
}
export function validateSnapshot(snapshot) {
  exactKeys(snapshot, ['schema_version', 'round', 'source', 'human_answers', 'artifacts', 'disposition', 'rationale', 'role_outputs', 'previous'], [], 'snapshot');
  assert(snapshot.schema_version === version, 'E_SCHEMA', 'Unsupported snapshot schema_version.');
  roundFile(snapshot.round);
  validateSource(snapshot.source);
  validateHumanAnswers(snapshot.human_answers);
  text(snapshot.rationale, 'snapshot.rationale');
  assert(['continue', 'needs-human', 'candidate'].includes(snapshot.disposition), 'E_SCHEMA', 'Invalid snapshot disposition.');
  validateArtifacts(snapshot.artifacts, snapshot);
  if (snapshot.round === 0) {
    assert(snapshot.previous === null && snapshot.role_outputs === null && snapshot.disposition === 'continue' && snapshot.human_answers.length === 0,
      'E_LINEAGE', 'Initial snapshot must have no previous round, role outputs, or human answers.');
    assert(encoded(snapshot.artifacts) === encoded(emptyArtifacts()), 'E_LINEAGE', 'Initial snapshot must contain the unmodeled initial bundle.');
  } else {
    exactKeys(snapshot.previous, ['file', 'sha256'], [], 'snapshot.previous');
    assert(snapshot.previous.file === roundFile(snapshot.round - 1) && hashPattern.test(snapshot.previous.sha256), 'E_LINEAGE', 'Invalid previous snapshot reference/hash.');
    const roles = snapshot.role_outputs;
    exactKeys(roles, ['agenda', 'proposals', 'expert', 'challenges', 'synthesis'], [], 'snapshot.role_outputs');
    assert(Array.isArray(roles.proposals) && roles.proposals.length === 3 && Array.isArray(roles.challenges) && roles.challenges.length === 3,
      'E_SCHEMA', 'A committed round needs all three proposals and challenges.');
    validateRole('agenda', roles.agenda, snapshot);
    validateRole('expert', roles.expert, snapshot);
    for (const [index, voice] of voices.entries()) {
      validateRole(`explore-${voice}`, roles.proposals[index], snapshot);
      validateRole(`challenge-${voice}`, roles.challenges[index], snapshot);
    }
    validateRole('synthesis', roles.synthesis, snapshot);
    assert(encoded(roles.synthesis.artifacts) === encoded(snapshot.artifacts), 'E_LINEAGE', 'Stored artifacts differ from the complete synthesis.');
    const gated = deriveDisposition(roles.synthesis);
    assert(gated.disposition === snapshot.disposition && gated.rationale === snapshot.rationale, 'E_LINEAGE', 'Stored disposition/rationale differs from deterministic readiness gates.');
  }
  return snapshot;
}
function answersExtend(previous, answers, knownQuestions) {
  validateHumanAnswers(answers);
  assert(answers.length >= previous.length && encoded(answers.slice(0, previous.length)) === encoded(previous),
    'E_LINEAGE', 'Human answer history must preserve every prior revision unchanged.');
  for (const row of answers.slice(previous.length)) {
    assert(knownQuestions.has(row.question_id), 'E_INPUT', `Unknown human-answer question ID ${row.question_id}.`);
    assert(knownQuestions.get(row.question_id) === row.question, 'E_LINEAGE',
      `Human answer for ${row.question_id} must retain the original exact question wording.`);
  }
}
function readLineage(snapshotPath, { allowStale = false } = {}) {
  pathText(snapshotPath, 'resume path');
  const path = canonicalFilePath(snapshotPath);
  const output = dirname(path);
  const round = roundOfFile(basename(path));
  assert(round !== null, 'E_LINEAGE', 'Resume must name a canonical round-NNNN.json snapshot.');
  if (!allowStale) {
    const later = readdirSync(output).filter((name) => { const n = roundOfFile(name); return n !== null && n > round; });
    assert(!later.length, 'E_STALE', `Stale resume: a later round already exists in ${output}. Resume its latest committed snapshot.`);
  }
  const chain = [];
  let cursor = round;
  let expectedHash = null;
  let targetHash = null;
  while (cursor >= 0) {
    const storedPath = join(output, roundFile(cursor));
    const { value, raw } = readJson(storedPath, null, `snapshot ${roundFile(cursor)}`);
    const hash = sha256(raw);
    assert(expectedHash === null || hash === expectedHash, 'E_LINEAGE', `Previous snapshot hash mismatch at ${storedPath}.`);
    validateSnapshot(value);
    assert(value.round === cursor, 'E_LINEAGE', `Snapshot filename/round mismatch at ${storedPath}.`);
    if (cursor === round) targetHash = hash;
    chain.push(value);
    expectedHash = value.previous?.sha256 || null;
    cursor--;
  }
  chain.reverse();
  const knownQuestions = new Map();
  let previousAnswers = [];
  let previousArtifacts = null;
  const source = encoded(chain[0].source);
  for (const stored of chain) {
    assert(encoded(stored.source) === source, 'E_LINEAGE', 'Source content, origin, or hash changed across lineage.');
    // Answers can only bind to questions from earlier validated snapshots, not
    // to wording introduced by the same round that records the human answer.
    answersExtend(previousAnswers, stored.human_answers, knownQuestions);
    validateQuestionTransition(previousArtifacts, stored.artifacts, knownQuestions);
    previousAnswers = stored.human_answers;
    previousArtifacts = stored.artifacts;
  }
  return { latest: { path, sha256: targetHash, round }, stored: chain.at(-1), knownQuestions };
}
// The model input is an exact projection of a full committed snapshot. Previous
// role transcripts stay in the durable snapshot, not in the next round's context.
// Explicit new human revisions are captured in the round's attempt manifest.
export function projectSnapshot(stored, humanAnswers = stored.human_answers) {
  return {
    schema_version: stored.schema_version, round: stored.round, source: stored.source,
    human_answers: humanAnswers, artifacts: stored.artifacts,
    disposition: stored.disposition, rationale: stored.rationale,
  };
}
export function loadSnapshot(snapshotPath, options = {}) {
  const loaded = readLineage(snapshotPath, options);
  if (options.expected) sameLatest(options.expected, loaded.latest);
  const result = { latest: loaded.latest, snapshot: projectSnapshot(loaded.stored) };
  return result;
}
function commitSnapshot(output, snapshot, draftDirectory) {
  validateSnapshot(snapshot);
  const raw = encoded(snapshot) + '\n';
  const path = join(output, roundFile(snapshot.round));
  const draft = join(draftDirectory, 'committed-snapshot.json');
  writeExclusive(draft, raw);
  syncDirectory(draftDirectory);
  // A fully written, fsynced inode is linked into place atomically. link refuses
  // existing destinations, unlike rename. Incomplete writes remain hidden drafts.
  try { linkSync(draft, path); } catch (error) {
    if (error.code === 'EEXIST') fail('E_STALE', `Snapshot already exists and was not overwritten: ${path}`);
    throw error;
  }
  syncDirectory(output);
  return { path, sha256: sha256(raw), round: snapshot.round };
}
function readConfig(configPath) {
  let absolute;
  try { absolute = realpathSync(resolve(pathText(configPath, 'config_path'))); } catch (error) {
    if (error instanceof ArtifactError) throw error;
    fail('E_INPUT', `Cannot read explicit configuration path: ${error.message}`);
  }
  const { value } = readJson(absolute, null, 'Configuration');
  assert(isObject(value), 'E_CONFIG', 'Configuration must be a JSON object.');
  const start = Object.hasOwn(value, 'document');
  const resume = Object.hasOwn(value, 'resume');
  assert(start !== resume, 'E_CONFIG', 'Supply exactly one mode: document/output, or resume/optional answers.');
  try {
    exactKeys(value, start ? ['document', 'output'] : ['resume'],
      start ? ['max_rounds'] : ['max_rounds', 'answers', 'attempt', 'redo'], 'config');
    for (const key of start ? ['document', 'output'] : ['resume']) pathText(value[key], `config.${key}`);
    if (Object.hasOwn(value, 'answers')) pathText(value.answers, 'config.answers');
    if (Object.hasOwn(value, 'attempt')) pathText(value.attempt, 'config.attempt');
    if (Object.hasOwn(value, 'redo')) {
      assert(Array.isArray(value.redo) && value.redo.length > 0 && value.redo.every((slot) => slots.includes(slot)),
        'E_CONFIG', 'redo must be a nonempty array of known role slots.');
    }
  } catch (error) { fail('E_CONFIG', error.message); }
  if (!start) {
    if (Object.hasOwn(value, 'attempt') && Object.hasOwn(value, 'answers')) {
      fail('E_CONFIG', 'attempt and answers are incompatible: a resumed in-progress round keeps the answers recorded in its attempt manifest.');
    }
    if (Object.hasOwn(value, 'redo') && !Object.hasOwn(value, 'attempt')) {
      fail('E_CONFIG', 'redo requires attempt to identify the resumed in-progress round.');
    }
  }
  const maxRounds = Object.hasOwn(value, 'max_rounds') ? value.max_rounds : 3;
  assert(Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 8, 'E_CONFIG', 'max_rounds must be an integer in 1..8.');
  return { config: value, directory: dirname(absolute), maxRounds };
}
function applyAnswers(loaded, answersPath) {
  let value;
  try { ({ value } = readJson(realpathSync(answersPath), null, 'Human answers input')); } catch (error) {
    if (error instanceof ArtifactError) throw error;
    fail('E_INPUT', `Cannot read explicit human answers: ${error.message}`);
  }
  assert(Array.isArray(value), 'E_INPUT', 'Human answers input must be an array of { question_id, answer }.');
  const seen = new Set();
  const answers = [...loaded.stored.human_answers];
  for (const row of value) {
    exactKeys(row, ['question_id', 'answer'], [], 'answer');
    checkSchema(row.question_id, identifier, 'answer.question_id');
    text(row.answer, 'answer.answer');
    assert(!seen.has(row.question_id), 'E_INPUT', `Duplicate human-answer question ID ${row.question_id}.`);
    seen.add(row.question_id);
    assert(loaded.knownQuestions.has(row.question_id), 'E_INPUT', `Unknown human-answer question ID ${row.question_id}.`);
    const revisions = answers.filter((answer) => answer.question_id === row.question_id);
    answers.push({ question_id: row.question_id, question: loaded.knownQuestions.get(row.question_id), answer: row.answer, revision: revisions.length + 1, attribution: 'human' });
  }
  answersExtend(loaded.stored.human_answers, answers, loaded.knownQuestions);
  return answers;
}
export function prepare({ config_path }) {
  const { config, directory, maxRounds } = readConfig(config_path);
  if (Object.hasOwn(config, 'resume')) {
    const loaded = readLineage(resolve(directory, config.resume));
    try {
      // Validate the in-progress round before publishing its model projection.
      // Pending revisions belong to that attempt, not the committed base.
      const state = Object.hasOwn(config, 'attempt') ? readAttempt(resolve(directory, config.attempt)) : null;
      if (state) sameLatest(state.manifest.base, loaded.latest);
      const answers = state ? state.manifest.human_answers
        : Object.hasOwn(config, 'answers') ? applyAnswers(loaded, resolve(directory, config.answers)) : loaded.stored.human_answers;
      const result = { latest: loaded.latest, snapshot: projectSnapshot(loaded.stored, answers), max_rounds: maxRounds, attempt: state?.path ?? null, redo: config.redo ?? [] };
      return result;
    } catch (error) {
      // Bad answer/attempt input does not invalidate the validated committed
      // resume point. Expose its reference without promoting any pending answer.
      if (error instanceof ArtifactError) error.latest = loaded.latest;
      throw error;
    }
  }
  let origin;
  let raw;
  try {
    origin = realpathSync(resolve(directory, config.document));
    raw = readBytes(origin, null, 'Strategic source document');
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    fail('E_INPUT', `Cannot read explicit strategic document: ${error.message}`);
  }
  const source = { origin, text: decode(raw, 'Strategic source document'), sha256: sha256(raw) };
  validateSource(source);
  const output = newOutputPath(resolve(directory, config.output));
  const stored = {
    schema_version: version, round: 0, source, human_answers: [], artifacts: emptyArtifacts(),
    disposition: 'continue', rationale: 'Exact strategic source captured. No workshop analysis or human approval has been performed.',
    role_outputs: null, previous: null,
  };
  // CLI transport writes a separate immutable input projection after commit.
  // The source itself never passes through a single shell reply.
  const expectedRaw = encoded(stored) + '\n';
  const latest = { path: join(output, roundFile(0)), sha256: sha256(expectedRaw), round: 0 };
  const result = { latest, snapshot: projectSnapshot(stored), max_rounds: maxRounds, attempt: null, redo: [] };
  createOutputDirectory(output);
  const draft = join(output, `.initial-${randomUUID()}`);
  mkdirSync(draft, { mode: 0o700 });
  result.latest = commitSnapshot(output, stored, draft);
  return result;
}
function validatePendingAnswers(loaded, answers) {
  answersExtend(loaded.stored.human_answers, answers, loaded.knownQuestions);
}
export function begin({ latest, human_answers, input_ref }) {
  validateLatest(latest);
  const loaded = readLineage(latest.path);
  sameLatest(latest, loaded.latest);
  if (input_ref !== undefined) {
    const input = JSON.parse(readInput(input_ref));
    assert(input.round === latest.round, 'E_LINEAGE', 'Input projection round does not match latest.');
    human_answers = input.human_answers;
    assert(encoded(input) === encoded(projectSnapshot(loaded.stored, human_answers)),
      'E_LINEAGE', 'Input projection does not match the committed snapshot and pending answers.');
  }
  validatePendingAnswers(loaded, human_answers);
  const round = latest.round + 1;
  roundFile(round);
  const output = dirname(loaded.latest.path);
  const attempt = join(output, `.attempt-${randomUUID()}`);
  const manifest = { schema_version: version, base: loaded.latest, round, human_answers, slots: {} };
  mkdirSync(attempt, { mode: 0o700 });
  writeExclusive(join(attempt, 'attempt.json'), encoded(manifest) + '\n');
  syncDirectory(attempt);
  syncDirectory(output);
  return { attempt, round, next_snapshot: join(output, roundFile(round)) };
}
function readAttempt(attemptPath, { allowStale = false } = {}) {
  const path = canonicalFilePath(pathText(attemptPath, 'attempt'));
  assert(/^\.attempt-[0-9a-f-]{36}$/.test(basename(path)), 'E_INPUT', 'Invalid attempt directory name.');
  const stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'E_INPUT', 'Attempt must be a real directory.');
  const { value: manifest } = readJson(join(path, 'attempt.json'), null, 'Attempt manifest');
  exactKeys(manifest, ['schema_version', 'base', 'round', 'human_answers'], ['slots'], 'attempt');
  assert(manifest.schema_version === version, 'E_SCHEMA', 'Unsupported attempt schema_version.');
  validateLatest(manifest.base);
  assert(manifest.round === manifest.base.round + 1, 'E_LINEAGE', 'Attempt round does not follow its base.');
  const loaded = readLineage(manifest.base.path, { allowStale });
  sameLatest(manifest.base, loaded.latest);
  assert(dirname(loaded.latest.path) === dirname(path), 'E_LINEAGE', 'Attempt directory is outside its snapshot directory.');
  validatePendingAnswers(loaded, manifest.human_answers);
  const slotsState = new Map();
  for (const slot of slots) {
    const entry = manifest.slots?.[slot];
    const exists = existsSync(rolePath(path, slot));
    const state = entry === undefined ? (exists ? 'staged' : 'missing') : entry.state;
    slotsState.set(slot, { state, entry });
  }
  return { path, manifest, loaded, snapshot: projectSnapshot(loaded.stored, manifest.human_answers), slotsState };
}
function rolePath(attempt, slot) { return join(attempt, `role-${slot}.json`); }
function readStagedRole(state, slot) {
  const path = rolePath(state.path, slot);
  assert(existsSync(path), 'E_ORDER', `Role ${slot} has not been staged.`);
  const { value, raw } = readJson(path, null, `role ${slot}`);
  const hash = sha256(raw);
  const entry = state.manifest.slots?.[slot];
  if (entry?.sha256) assert(hash === entry.sha256, 'E_LINEAGE', `Role ${slot} content hash mismatch.`);
  return { path, value, text: decode(raw, `role ${slot}`), hash };
}
function requireRoleOrder(attempt, slot) {
  const position = slots.indexOf(slot);
  assert(position >= 0, 'E_SCHEMA', `Unknown role slot ${slot}.`);
  for (const [index, candidate] of slots.entries()) {
    const present = existsSync(rolePath(attempt, candidate));
    assert(index < position ? present : true, 'E_ORDER', `Role ${slot} is missing a predecessor.`);
  }
}
export function attemptStatus({ attempt }) {
  const state = readAttempt(attempt, { allowStale: true });
  const slotsStatus = [];
  for (const [slot, { state: slotState }] of state.slotsState) slotsStatus.push({ slot, state: slotState });
  return { attempt: state.path, round: state.manifest.round, base: state.manifest.base, slots: slotsStatus };
}
export function invalidateRoles({ attempt, slots: targets }) {
  const state = readAttempt(attempt, { allowStale: true });
  for (const target of targets) assert(slots.includes(target), 'E_SCHEMA', `Unknown role slot ${target}.`);
  const manifest = state.manifest;
  manifest.slots ??= {};
  const targetSet = new Set(targets);
  let mark = false;
  for (const slot of slots) {
    if (mark || targetSet.has(slot)) {
      mark = true;
      if (!existsSync(rolePath(state.path, slot))) continue;
      manifest.slots[slot] = { state: 'stale' };
    }
  }
  writeReplace(join(state.path, 'attempt.json'), encoded(manifest) + '\n');
  return attemptStatus({ attempt: state.path });
}
export function readRole({ attempt, slot }) {
  const state = readAttempt(attempt, { allowStale: true });
  assert(slots.includes(slot), 'E_SCHEMA', `Unknown role slot ${slot}.`);
  const role = readStagedRole(state, slot);
  validateRole(slot, role.value, state.snapshot);
  return { path: role.path, sha256: role.hash, length: role.text.length };
}
export function roleChunk({ role_ref, offset }) {
  exactKeys(role_ref, ['path', 'sha256', 'length'], [], 'role_ref');
  pathText(role_ref.path, 'role_ref.path');
  assert(hashPattern.test(role_ref.sha256) && Number.isSafeInteger(role_ref.length) && role_ref.length > 0,
    'E_INPUT', 'Invalid staged-role descriptor.');
  assert(/^role-[a-z-]+\.json$/.test(basename(role_ref.path)) && /^\.attempt-[0-9a-f-]{36}$/.test(basename(dirname(role_ref.path))),
    'E_INPUT', 'Invalid staged-role filename.');
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset < role_ref.length,
    'E_INPUT', 'Staged-role packet offset must be within the role.');
  const raw = readBytes(role_ref.path, null, 'Staged role');
  assert(sha256(raw) === role_ref.sha256, 'E_LINEAGE', 'Staged-role content hash mismatch.');
  const text = decode(raw, 'Staged role');
  assert(text.length === role_ref.length, 'E_LINEAGE', 'Staged-role length mismatch.');
  const portion = text.slice(offset, offset + limits.input_chunk);
  return { offset, next: offset + portion.length, length: text.length, sha256: role_ref.sha256, text: portion };
}
export function stage({ attempt, slot, output, output_ref }) {
  const state = readAttempt(attempt);
  requireRoleOrder(state.path, slot);
  assert(slot !== 'synthesis', 'E_ORDER', 'Use finish to validate synthesis and commit the complete round.');
  if (output_ref !== undefined) output = readOutput(output_ref, state.path, slot);
  validateRole(slot, output, state.snapshot);
  const entry = state.manifest.slots?.[slot];
  const exists = existsSync(rolePath(state.path, slot));
  const isStale = entry?.state === 'stale';
  if (exists && !isStale) {
    fail('E_ORDER', `Role ${slot} has already been staged; invalidate it first to redo.`);
  }
  const raw = encoded(output) + '\n';
  if (exists && isStale) {
    writeReplace(rolePath(state.path, slot), raw);
  } else {
    writeExclusive(rolePath(state.path, slot), raw);
  }
  syncDirectory(state.path);
  const manifest = state.manifest;
  manifest.slots ??= {};
  manifest.slots[slot] = { state: 'staged', sha256: sha256(raw) };
  writeReplace(join(state.path, 'attempt.json'), encoded(manifest) + '\n');
  return { round: state.manifest.round, slot };
}
export function finish({ attempt, output, output_ref }) {
  const state = readAttempt(attempt);
  requireRoleOrder(state.path, 'synthesis');
  if (output_ref !== undefined) output = readOutput(output_ref, state.path, 'synthesis');
  validateRole('synthesis', output, state.snapshot);
  for (const slot of slots) {
    const entry = state.manifest.slots?.[slot];
    assert(entry?.state !== 'stale', 'E_ORDER', `Role ${slot} is stale; rerun or invalidate it before finish.`);
  }
  const recorded = new Map();
  for (const slot of slots.slice(0, -1)) {
    const { value } = readStagedRole(state, slot);
    validateRole(slot, value, state.snapshot);
    recorded.set(slot, value);
  }
  const synthesisPath = rolePath(state.path, 'synthesis');
  if (existsSync(synthesisPath)) {
    const authored = readStagedRole(state, 'synthesis');
    assert(encoded(output) === encoded(authored.value), 'E_LINEAGE', 'Synthesis output does not match the authored staged synthesis.');
  }
  const gated = deriveDisposition(output);
  const stored = {
    schema_version: version, round: state.manifest.round, source: state.loaded.stored.source,
    human_answers: state.manifest.human_answers, artifacts: output.artifacts,
    ...gated,
    role_outputs: {
      agenda: recorded.get('agenda'), proposals: voices.map((voice) => recorded.get(`explore-${voice}`)),
      expert: recorded.get('expert'), challenges: voices.map((voice) => recorded.get(`challenge-${voice}`)), synthesis: output,
    },
    previous: { file: basename(state.loaded.latest.path), sha256: state.loaded.latest.sha256 },
  };
  validateSnapshot(stored);
  // Author the synthesis role atomically (overwrite-safe): an interruption after
  // the write but before the exclusive commit must not strand the attempt on a
  // retried finish.
  const synthesisRaw = encoded(output) + '\n';
  writeReplace(synthesisPath, synthesisRaw);
  syncDirectory(state.path);
  const manifest = state.manifest;
  manifest.slots ??= {};
  manifest.slots['synthesis'] = { state: 'staged', sha256: sha256(synthesisRaw) };
  writeReplace(join(state.path, 'attempt.json'), encoded(manifest) + '\n');
  // Recheck lineage immediately before the exclusive commit. Concurrent attempts
  // can still race here; link's exclusive destination decides the single winner.
  const current = readLineage(state.manifest.base.path);
  sameLatest(state.manifest.base, current.latest);
  const latest = commitSnapshot(dirname(current.latest.path), stored, state.path);
  return { latest, ...gated };
}
// Read-only recovery of an initial commit whose shell reply was lost. It never
// starts/resumes a workshop or treats an uncommitted draft as a snapshot.
export function inspect({ config_path }) {
  const { config, directory } = readConfig(config_path);
  const output = Object.hasOwn(config, 'resume')
    ? dirname(canonicalFilePath(resolve(directory, config.resume)))
    : canonicalDirectory(resolve(directory, config.output));
  const rounds = readdirSync(output).map(roundOfFile).filter((round) => round !== null);
  if (!rounds.length) return { latest: null };
  const latestRound = rounds.reduce((highest, round) => Math.max(highest, round), 0);
  const loaded = readLineage(join(output, roundFile(latestRound)));
  return { latest: loaded.latest };
}
export function recover({ attempt }) {
  const state = readAttempt(attempt, { allowStale: true });
  const output = dirname(state.loaded.latest.path);
  const rounds = readdirSync(output).map(roundOfFile).filter((round) => round !== null && round >= state.manifest.base.round);
  const latestRound = rounds.reduce((highest, round) => Math.max(highest, round), state.manifest.base.round);
  const loaded = readLineage(join(output, roundFile(latestRound)));
  // readLineage checks every link back to round zero; require our exact base too.
  const base = readLineage(state.manifest.base.path, { allowStale: true });
  sameLatest(state.manifest.base, base.latest);
  return { latest: loaded.latest, disposition: loaded.stored.disposition, rationale: loaded.stored.rationale };
}

// Only metadata crosses prepare/load stdout. Exact JSON input is retained in an
// immutable file, then read in bounded UTF-16 slices (including split surrogate
// pairs, which JSON escapes and concatenation restore without loss). Each read
// checks the complete file hash, so mixed/replaced packet streams fail closed.
function inputTransport(result) {
  const raw = encoded(result.snapshot);
  const path = join(dirname(result.latest.path), `.input-${randomUUID()}.json`);
  const input_ref = { path, sha256: sha256(raw), length: raw.length };
  const { snapshot, ...metadata } = result;
  const response = { ...metadata, input_ref };
  packet({ ok: true, data: response });
  writeExclusive(path, raw);
  syncDirectory(dirname(path));
  return response;
}
function readInput(inputRef) {
  exactKeys(inputRef, ['path', 'sha256', 'length'], [], 'input_ref');
  pathText(inputRef.path, 'input_ref.path');
  assert(hashPattern.test(inputRef.sha256) && Number.isSafeInteger(inputRef.length) && inputRef.length > 0,
    'E_INPUT', 'Invalid input projection descriptor.');
  assert(/^\.input-[0-9a-f-]{36}\.json$/.test(basename(inputRef.path)), 'E_INPUT', 'Invalid input projection filename.');
  const raw = readBytes(inputRef.path, null, 'Input projection');
  assert(sha256(raw) === inputRef.sha256, 'E_LINEAGE', 'Input projection hash mismatch.');
  const text = decode(raw, 'Input projection');
  assert(text.length === inputRef.length, 'E_LINEAGE', 'Input projection length mismatch.');
  return text;
}
export function inputChunk({ input_ref, offset }) {
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset < input_ref?.length,
    'E_INPUT', 'Input packet offset must be within the exact projection.');
  const input = readInput(input_ref);
  const text = input.slice(offset, offset + limits.input_chunk);
  return { offset, next: offset + text.length, length: input.length, sha256: input_ref.sha256, text };
}

// Outbound JSON uses immutable, hash-linked UTF-16 chunks. Each acknowledgement
// echoes the exact text and predecessor for verification by the workflow. The
// final stage/finish supplies the acknowledged tail hash, not the full output.
// Reassembly verifies every link, exact contiguous coverage, length and binding
// BEFORE schema validation or role/snapshot publication. Drafts are retained.
export function outputBegin({ attempt, slot, length }) {
  const state = readAttempt(attempt);
  requireRoleOrder(state.path, slot);
  assert(Number.isSafeInteger(length) && length > 0, 'E_INPUT', 'Output length must be a positive safe integer.');
  const path = join(state.path, `.output-${randomUUID()}`);
  const manifest = { attempt: state.path, slot, length };
  const response = { path, ...manifest };
  packet({ ok: true, data: response });
  mkdirSync(path, { mode: 0o700 });
  writeExclusive(join(path, 'output.json'), encoded(manifest) + '\n');
  syncDirectory(path);
  syncDirectory(state.path);
  return response;
}
function readUpload(upload) {
  const path = canonicalFilePath(pathText(upload, 'output upload'));
  assert(/^\.output-[0-9a-f-]{36}$/.test(basename(path)), 'E_INPUT', 'Invalid output upload directory name.');
  const stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'E_INPUT', 'Output upload must be a real directory.');
  const { value: manifest } = readJson(join(path, 'output.json'), null, 'Output upload manifest');
  exactKeys(manifest, ['attempt', 'slot', 'length'], [], 'output upload');
  assert(manifest.attempt === dirname(path) && slots.includes(manifest.slot) && Number.isSafeInteger(manifest.length) && manifest.length > 0,
    'E_LINEAGE', 'Output upload has invalid attempt, slot or length binding.');
  return { path, manifest };
}
function validateTail(tail) {
  exactKeys(tail, ['offset', 'sha256'], [], 'output tail');
  assert(Number.isSafeInteger(tail.offset) && tail.offset >= 0 && hashPattern.test(tail.sha256), 'E_INPUT', 'Invalid output tail descriptor.');
}
function readOutputChunk(path, tail) {
  validateTail(tail);
  const { value, raw } = readJson(join(path, `chunk-${tail.offset}.json`), limits.packet, 'Output chunk');
  assert(sha256(raw) === tail.sha256, 'E_LINEAGE', 'Output chunk hash mismatch.');
  exactKeys(value, ['offset', 'text', 'previous'], [], 'output chunk');
  assert(value.offset === tail.offset && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= limits.output_chunk,
    'E_LINEAGE', 'Output chunk offset or text length mismatch.');
  return value;
}
export function outputChunk({ upload, offset, text, previous }) {
  const { path, manifest } = readUpload(upload);
  assert(Number.isSafeInteger(offset) && offset >= 0 && typeof text === 'string' && text.length > 0 && text.length <= limits.output_chunk &&
    offset + text.length <= manifest.length, 'E_INPUT', 'Output chunk is outside the declared length or packet size.');
  if (offset === 0) assert(previous === null, 'E_LINEAGE', 'First output chunk must have no predecessor.');
  else {
    const predecessor = readOutputChunk(path, previous);
    assert(predecessor.offset + predecessor.text.length === offset, 'E_LINEAGE', 'Output chunks must be contiguous and ordered.');
  }
  const raw = encoded({ offset, text, previous }) + '\n';
  const response = { upload: path, offset, next: offset + text.length, length: manifest.length, text, previous, sha256: sha256(raw) };
  packet({ ok: true, data: response });
  writeExclusive(join(path, `chunk-${offset}.json`), raw);
  syncDirectory(path);
  return response;
}
function readOutput(outputRef, attempt, slot) {
  exactKeys(outputRef, ['path', 'length', 'tail'], [], 'output_ref');
  const { path, manifest } = readUpload(outputRef.path);
  assert(manifest.attempt === attempt && manifest.slot === slot && manifest.length === outputRef.length,
    'E_LINEAGE', 'Output upload does not match this attempt, role or declared length.');
  let tail = outputRef.tail;
  let next = manifest.length;
  const parts = [];
  while (tail !== null) {
    const chunk = readOutputChunk(path, tail);
    assert(chunk.offset + chunk.text.length === next, 'E_LINEAGE', 'Output upload is incomplete or noncontiguous.');
    parts.push(chunk.text);
    next = chunk.offset;
    tail = chunk.previous;
  }
  assert(next === 0 && parts.length > 0, 'E_LINEAGE', 'Output upload must cover its complete declared length.');
  const raw = parts.reverse().join('');
  assert(raw.length === manifest.length, 'E_LINEAGE', 'Output upload length mismatch.');
  let output;
  try { output = JSON.parse(raw); } catch (error) {
    if (isResourceError(error)) resourceFailure(error);
    fail('E_INPUT', 'Complete output upload must contain valid JSON.');
  }
  // The native object was serialized once by the workflow. Re-encoding must
  // preserve that exact JSON, not adopt a different representation silently.
  assert(encoded(output) === raw, 'E_LINEAGE', 'Output upload is not the exact native JSON representation.');
  return output;
}
function outputRequest(request, required) {
  exactKeys(request, required, ['output', 'output_ref'], 'request');
  assert(Object.hasOwn(request, 'output') !== Object.hasOwn(request, 'output_ref'), 'E_INPUT', 'Supply exactly one of output or output_ref.');
}

/** Synchronous CLI dispatcher, also importable for offline tests. */
export function dispatch(operation, request) {
  switch (operation) {
    case 'schemas': exactKeys(request, [], [], 'request'); return schemas;
    case 'prepare': exactKeys(request, ['config_path'], [], 'request'); return inputTransport(prepare(request));
    case 'input': exactKeys(request, ['input_ref', 'offset'], [], 'request'); return inputChunk(request);
    case 'begin':
      exactKeys(request, ['latest'], ['human_answers', 'input_ref'], 'request');
      assert(Object.hasOwn(request, 'human_answers') !== Object.hasOwn(request, 'input_ref'), 'E_INPUT', 'Supply exactly one of human_answers or input_ref.');
      return begin(request);
    case 'output-begin': exactKeys(request, ['attempt', 'slot', 'length'], [], 'request'); return outputBegin(request);
    case 'output-chunk': exactKeys(request, ['upload', 'offset', 'text', 'previous'], [], 'request'); return outputChunk(request);
    case 'stage': outputRequest(request, ['attempt', 'slot']); return stage(request);
    case 'attempt-status': exactKeys(request, ['attempt'], [], 'request'); return attemptStatus(request);
    case 'invalidate-roles': exactKeys(request, ['attempt', 'slots'], [], 'request'); return invalidateRoles(request);
    case 'role-read': exactKeys(request, ['attempt', 'slot'], [], 'request'); return readRole(request);
    case 'role-chunk': exactKeys(request, ['role_ref', 'offset'], [], 'request'); return roleChunk(request);
    case 'finish': {
      outputRequest(request, ['attempt']);
      const { latest, disposition } = finish(request);
      return { latest, disposition }; // Full uncapped rationale stays in the snapshot.
    }
    case 'load': exactKeys(request, ['latest'], [], 'request'); validateLatest(request.latest); return inputTransport(loadSnapshot(request.latest.path, { expected: request.latest }));
    case 'recover': {
      exactKeys(request, ['attempt'], [], 'request');
      const { latest, disposition } = recover(request);
      return { latest, disposition };
    }
    case 'inspect': exactKeys(request, ['config_path'], [], 'request'); return inspect(request);
    default: fail('E_INPUT', 'Use schemas, prepare, input, begin, output-begin, output-chunk, stage, attempt-status, invalidate-roles, role-read, role-chunk, finish, load, recover, or inspect.');
  }
}
export function main(operation = process.argv[2]) {
  try {
    // stdin can be a pipe, so do not use the regular-file-only readBytes helper.
    const buffer = Buffer.alloc(limits.packet);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(0, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    assert(length < limits.packet, 'E_SIZE', 'Shell input packet must be below 45 KiB.');
    const input = decode(buffer.subarray(0, length), 'Shell input');
    let request;
    try { request = JSON.parse(input || '{}'); } catch { fail('E_INPUT', 'Shell input must be one JSON request.'); }
    const data = dispatch(operation, request);
    process.stdout.write(packet({ ok: true, data }));
    return 0;
  } catch (error) {
    const resource = isResourceError(error);
    const code = error instanceof ArtifactError ? error.code : resource ? 'E_RESOURCE' : 'E_IO';
    const diagnostic = (resource ? 'Host resource limit prevented complete input/output processing; no partial data was accepted: ' : '') + String(error.message || error).slice(0, 4096);
    const recovery = error instanceof ArtifactError && error.latest ? { latest: error.latest } : {};
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message: diagnostic, ...recovery } }) + '\n');
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
