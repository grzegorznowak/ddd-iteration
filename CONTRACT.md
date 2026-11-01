# Architecture iteration: implementation contract

This is a separate, artifact-driven workshop. It does not extend the paused review pipeline.

## Package source and project installation

`workflows/architecture-iteration/` owns the canonical `architecture-iteration.js`, `artifacts.mjs`, `install.mjs` and five `skills/architecture-iteration-{master,expert,journey,model,stressor}/SKILL.md` directories. Discovery locations contain links, not maintained copies.

`node workflows/architecture-iteration/install.mjs [--project <existing root>] [--dry-run]` defaults to the source repository root, independent of caller cwd. It links the canonical workflow as `.pi/workflows/architecture-iteration.js` and each canonical skill directory under `.pi/skills/`. It has no external dependencies, global mode or settings edits. It preflights every destination before writes, refuses collisions without overwrite/deletion, and treats same-target symlinks as existing. Dry-run writes nothing. The programmatic export is `install({ project = sourceRepositoryRoot, dryRun = false } = {})`, returning `{ project, dryRun, links: [{ source, destination, status }] }`; status is `linked`, `existing` or `planned`.

Start Pi from the target project root and reload resources after installation or skill changes. Inspect project trust and discovery diagnostics. Bare-name invocation and the explicit installed path are supported; native workflow completion can omit symlinked files. No global or arbitrary-path launch is supported. The source checkout must remain available.

Before artifact preparation, bounded read-only Node preflight resolves only the fixed project link and canonical repository path. It selects `artifacts.mjs` beside the canonical workflow. A present invalid/broken installed link is fatal; it must not fall back. A conflicting installed link and repository workflow is also fatal. With no installed link, direct canonical source invocation from the source repository root is supported. The package marker checks compatibility, not authenticity or the identity of an arbitrary explicitly launched file: the host exposes no executing-file path.

## Public input and persistence

From the installed target project root, use either:

```text
/workflow architecture-iteration ./workshop.json
/workflow ./.pi/workflows/architecture-iteration.js ./workshop.json
```

From the source repository root, direct source invocation is also supported:

```text
/workflow ./workflows/architecture-iteration/architecture-iteration.js ./workshop.json
```

The argument is one JSON configuration file path (the entire trimmed argument, optionally quoted), resolved from the project working directory. Configuration paths resolve relative to that file, not to model output. Exactly one mode:

- Start: `{ "document": "strategy.md", "output": "workshop-artifacts", "max_rounds": 3 }`.
- Resume: `{ "resume": "workshop-artifacts/round-0001.json", "max_rounds": 3, "answers": "answers.json" }`.

`max_rounds` defaults to 3 and must be an integer in 1..8. It limits new rounds in this invocation. Output must be a new directory. Never overwrite existing evidence. Resume reads a full committed snapshot, not a notebook or previous conversation. Answers are optional on resume, supplied explicitly by a human as an array of `{ "question_id": "Q1", "answer": "..." }`. Unknown/duplicate question IDs are errors. They become attributed human evidence, not model claims. Answers can revise a prior answer with a recorded new revision; the original snapshot remains intact.

Store a complete initial snapshot (`round-0000.json`) containing the exact source text, SHA-256 and origin. Each subsequent `round-NNNN.json` contains the full source, cumulative human answers, full current artifacts, round disposition/rationale, role outputs, and previous snapshot reference/hash. Host-owned answer revisions include the exact original `question` wording, `question_id`, `answer`, `revision` and human `attribution`; short answers retain their proposition in fresh rounds. Snapshot metadata and source are host-owned, not supplied by the model. Resume validates stored data, hashes and lineage, and refuses a stale snapshot if a later round already exists. Commit with exclusive creation. If a response, reset, validation or commit fails, leave the previous snapshot resumable. Checkpoint only after durable commit; include its path in exits/checkpoints. Do not use workflow notebook writes or entries as transport.

Use a small deterministic Node companion (`artifacts.mjs`) for filesystem I/O, schemas and validation. Workflow calls it through `workflow.shell`, quotes paths, uses collision-safe stdin for JSON, and rejects failed/killed/truncated replies. Support offline import of companion functions for tests. No external npm dependencies. Avoid introducing a generic framework.

There is no fixed package byte cap on source text, configuration, cumulative human answers, ordinary role outputs, artifact bundles, complete synthesis responses, attempt manifests or stored snapshots. Preserve complete input and native structured output; never silently truncate or summarize them. Retain valid-UTF-8, regular-file, schema, lineage and immutable-commit checks. `max_rounds` remains 1..8 per invocation; live runs still need finite host time/cost budgets.

Keep each shell control request/reply below 45 KiB (Pi may truncate output near 50 KiB). CLI `prepare`/`load` return metadata and an `input_ref` descriptor (`path`, SHA-256, UTF-16 length), not source or answer text. Write the complete exact model projection in a new immutable `.input-<uuid>.json` file beside snapshots. The workflow loads explicit offset packets via `input`, at most 4,000 UTF-16 code units per reply, checks offsets/length/hash identity and complete coverage, then parses the full JSON before any model turn. JSON encoding must preserve split surrogate pairs and control characters. The companion verifies the complete file hash on each read. CLI `begin` receives the descriptor instead of transporting cumulative answers; verify the projection equals the committed snapshot plus validated pending answer revisions. Retained input files are not resume points. Programmatic prepare/load helpers may return the full projection for offline use.

Outbound persistence must not send a complete unbounded response in one shell request. Serialize native `result.output` exactly once. `output-begin` binds a retained `.output-<uuid>` upload directory to the attempt, role slot and UTF-16 length; `output-chunk` writes exclusive immutable records of at most 4,000 UTF-16 code units. Each record contains its offset, exact text and preceding record's offset/SHA-256. The acknowledgement echoes exact text/predecessor and upload/offset/next/total metadata plus the new record hash. Verify all of these before proceeding. Preserve split surrogate pairs and escaped controls losslessly.

`stage`/`finish` take an `output_ref` (`path`, `length`, tail offset/hash). Reconstruct backward from the acknowledged tail, verifying every hash, contiguous complete coverage, length, attempt/role binding and exact JSON round-trip BEFORE ordinary schema/evidence/DAG/question-continuity validation and immutable publication. Never commit partial uploads. Missing/replaced/reordered/duplicate chunks must fail closed, not truncate or overwrite. Keep all uploads as evidence; they are not resume points. Importable stage/finish helpers and bounded direct CLI requests may also accept `output`; CLI requires exactly one of `output` or `output_ref`. CLI finish/recover replies contain only snapshot reference and disposition: full uncapped rationale remains in the committed snapshot, not bounded shell metadata or the exit summary.

Node/OS memory/string/file limits, host transport/runtime budgets and provider context/generation ceilings remain inherent constraints. Chunked transport does not enlarge model capacity; every role still receives the full source and human-answer history plus preceding current-round outputs. Native output still crosses the host/sandbox JSON boundary in full. Stop clearly on these failures; never substitute partial data. Terminal host stops can prevent workflow recovery. Full-file hashing per packet and full lineage validation cost time; finite host budgets remain the bound. Keep schemas out of domain input packet accounting.

## Rounds and role API

Every round, including the first, executes `workflow.new()` BEFORE any model turn, then `workflow.readonly(true)`. A failed reset must stop, not continue in old context. Capture/restore entry readonly posture on ordinary completion/failure; document that cancellation can bypass restoration. Project-link installation does not authorize a live workshop; provider-backed runs require separate human authorization.

Nine serial turns per successful round:

1. `/skill:architecture-iteration-master` phase `agenda`.
2. Three `/skill:architecture-iteration-{journey,model,stressor}` phase `explore` turns (fixed order).
3. `/skill:architecture-iteration-expert` phase `answer`.
4. The same three participants, phase `challenge`, now seeing all proposals and expert answers.
5. `/skill:architecture-iteration-master` phase `synthesize`.

Every run has nonempty `args` (e.g. `round-1 agenda`) and explicit `input`: `{ round, phase, snapshot, agenda?, proposals?, expert?, challenges? }`. Snapshot is the only prior-round domain input. Role instructions are static method, not new domain evidence. No model research/execution tools, notebook, web, ambient repo reads, spawning or human-approval invention are requested; the host's native structured-output tool is permitted. State clearly that fresh sessions and readonly do not enforce a security sandbox. Use explicit skills with readonly frontmatter; model groups are optional, not hard-coded orchestration API.

All turns use native structured `result.output`, never JSON parsed from result.text. Shared schemas are exported by the companion. Exact schema details may be refined by the implementation owner, but preserve this semantic interface:

- Agenda: `focus`, `stage` (`big-picture`, `process`, `design`), `questions` (strings).
- Participant (both phases): `voice`, `observations` (strings), `proposals` (strings), `questions` (strings), `dissent` (strings). Voice equals the skill's stable name: `journey`, `model`, `stressor`.
- Expert: `answers` array of `{ question, answer, evidence: string[], status: "grounded" | "hypothesis" | "unknown" }`, `unresolved` (strings). Grounded answers require source line or human-answer references; unknowns remain open. No fabricated facts.
- Synthesis: `{ artifacts, disposition: "continue" | "needs-human" | "candidate", rationale }`. All artifacts are a full replacement snapshot, never just a delta. Preserve unresolved dissent and decision history unless explicitly resolved with rationale.

## Artifact bundle

Use these named sections, each with `{ status: "modeled" | "not-modeled" | "not-applicable", content: "Markdown" }`:

`shared_understanding`, `ubiquitous_language`, `subdomains`, `process_model`, `rules_and_aggregates`, `bounded_contexts`, `context_map`, `architecture_candidates`, `stressor_analysis`, `assumptions`, `decisions`, `change_log`.

`not-modeled` and `not-applicable` must explain why in content. These sections cover business purpose/scope, glossary, core/supporting/generic classification, commands/actors/policies/read models, invariants/consistency/aggregate candidates, bounded-context canvases and integration relationships, deployment/service options including modular monolith, stressor/residue matrix, uncertainty, decisions/rationale/dissent, and round changes.

Also include a structured `event_flow`:

- `events`: array `{ id, name, actor, scenario, evidence: string[], confidence: "grounded" | "hypothesis" }`; use past-tense business event names.
- `relations`: array `{ from, to, kind: "precedes" | "causes" | "alternative" | "parallel", note }`.
- `hotspots`: string array, including unknown order, branch conditions, failures and time constraints.

Validate unique event IDs and relation references; reject self-links and cycles in the strict precedence/causality subgraph. Alternative/parallel relations are not precedence edges. Do not force a total order.

Include `open_questions`: array `{ id, question, blocking: boolean }`. Validate unique IDs and retain exact wording under each ID.

Include cumulative `question_resolutions`: array `{ question_id, question, resolution, evidence: string[] }`. Preserve all previous records unchanged and in order. Removing a prior open question, or demoting a prior blocker to nonblocking, requires a NEW resolution record with its exact wording, an explanation and at least one checked source/human reference. Reopening the same question is allowed; another closure requires another record. Validate these transitions during synthesis and lineage loading. Human answers are evidence, not automatic closure. Reference validity proves existence, not semantic support; model/human review must check relevance.

## Exit/readiness contract

Force `needs-human` when any blocking question remains. `candidate` is allowed only with business events and all named sections marked modeled or justified not-applicable; it means a candidate for HUMAN review, not stakeholder agreement or approval. Otherwise continue until the round cap. Reasons: `needs-input`, `needs-human`, `candidate`, `round-limit`, `failed` (do not reuse engine-reserved `error`). Exit metadata includes latest snapshot path and round. Ordinary failure returns its diagnostic and latest durable artifact reference. A failed attempt must not create an apparently committed incomplete round.

## Offline verification

Check fresh-first/each-round reset ordering, role order/voices and explicit input, artifact-only resume, reset failure stop, ordinary posture restoration, full source/answer/config transport beyond former caps, role/artifact/synthesis output beyond former caps, large immutable snapshots, bounded per-packet envelopes, exact outbound hash-chain and complete-coverage verification, large rationale metadata isolation, multi-packet integrity/truncation failures, malformed structured data, grounded-evidence constraints, DAG/reference failures, human blocker/candidate gates, immutable commits/stale resume/lineage tampering, shell transport failure/truncation and paths containing spaces/quotes. Compile with the real source compiler (see README for the optional installed dependency hook). Install links into a fresh temporary project root, assert canonical symlink targets and validate actual selected installed Pi skill discovery and prompt entries offline. Do not install into live/global roots for these checks. Do not claim provider-history isolation or live model/domain accuracy from mocks.
