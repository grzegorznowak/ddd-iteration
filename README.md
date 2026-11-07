# ddd-iteration

A standalone, artifact-driven domain-design iteration workflow for [pi](https://pi.dev). Five voices — Journey, Model, Stressor, Expert, Master — converge over rounds of evidence-disciplined exploration and challenge, producing structured DDD-style architecture artifacts gated by human answers and immutable snapshots.

This is the released form of the `architecture-iteration` package. In a consuming project, the workflow and its artifact companion are installed as regular copies (so the workflow appears in the pi host's `/workflows` TUI list, which ignores symlinked `.js` files); the five skills stay symlinks into this repository. One source of truth for the skills; the workflow/companion copies are refreshed by rerunning the installer (see below).

## Dependencies

- **pi host** — the runtime that loads and runs the workflow. Developed against pi v1.4.0; any current 1.x should work, but pin what you validated.
- **pi-schematic plugin** — provides `model-group:` frontmatter routing used by the five voice skills. The running/validated version of the plugin is:
  - `git:github.com/chunkhound/pi-schematic@feat/workflow` — commit `4c68b4f` — version `0.7.0`
  - Install per pi-schematic's own instructions (plugin checkout under the pi agent environment, `git` layout as documented there). Do not rely on an npm-published copy: routing parity is validated against this pinned branch.
- **model-groups config** — each consuming project must define the five groups under `.pi/pi-schematic/model-groups.json` (schema v2). See **Model-group routing** below.
- Node.js 24 is used in CI; the artifact engine and installer use only Node built-ins (no external packages).

## What you get

- A serial 9-turn round (agenda → explore ×3 → expert answer → challenge ×3 → synthesis), with a fresh context before every invocation
- Five stable voice definitions (`architecture-iteration-{master,expert,journey,model,stressor}`), each with its own skill, model-group route and output contract
- A deterministic artifact engine (`artifacts.mjs`): JSON-schema validation, SHA-256 snapshot lineage, question resolution, recover/inspect, chunked transport (45 KiB shell packets, 4000-char chunks), and attempt-token resumable rounds (staged roles survive an interrupted run and are reused on resume)
- An installer (`install.mjs`) with strict no-overwrite/no-delete preflight: regular copies of the workflow and its artifact companion, symlinks for the skills
- No external npm dependencies; headless tests in `test/`

## Install into a project

```bash
git clone https://github.com/<owner>/ddd-iteration ~/ddd-iteration
cd /path/to/your/project
node ~/ddd-iteration/install.mjs
```

The current working directory is the project — there is nothing else to decide. Start pi from this directory and reload resources after installation. The installer writes:

- `.pi/workflows/architecture-iteration.js` → regular copy of canonical `architecture-iteration.js`
- `.pi/workflows/artifacts.mjs` → regular copy of canonical `artifacts.mjs` (the workflow's shell companion)
- `.pi/skills/architecture-iteration-<voice>` → symlink to canonical skill directories

The workflow is a regular copy — not a symlink — so it appears in the `/workflows` TUI list; the host's list ignores symlinked `.js` files, though bare-name `/workflow architecture-iteration` resolution would still work. Skills stay symlinks: the skill loader follows them, so skill edits propagate from the canonical source. A previously installed correct workflow symlink (from older installer versions) is upgraded to the copy automatically on rerun. If you change the canonical workflow or companion, rerun the installer after removing the old `.pi/workflows` copies — an identical copy rerun reports `existing`; a different copy is a refused conflict. Run `node install.mjs --help` for flags; `--dry-run` checks everything without writing; rerunning is safe and idempotent.

## Run the workflow

From the installed project root:

```text
/workflow architecture-iteration ./workshop.json
```

Configuration (one JSON file path, optionally quoted):

- Start: `{ "document": "strategy.md", "output": "workshop-artifacts", "max_rounds": 3 }`
- Resume: `{ "resume": "workshop-artifacts/round-0001.json", "max_rounds": 3, "answers": "answers.json" }`
- Resume an interrupted round: `{ "resume": "workshop-artifacts/round-0000.json", "attempt": "workshop-artifacts/.attempt-<uuid>", "redo": ["explore-model"] }`

`max_rounds` is an integer in 1..8 (default 3). Resume accepts explicit human answers as `[{ "question_id": "Q1", "answer": "..." }]`; unknown/duplicate IDs are errors. Answers become attributed human evidence (`human:Q1:r1`), never model claims. The `attempt` token (printed in `round-begin` checkpoints and failure diagnostics) is the path of the unfinished round's durable staging directory; already-staged roles are reused, only missing roles run. Supply `redo` (a nonempty array of role slots) only together with `attempt`; it invalidates a slot and all of its dependents so they are re-run. Staged roles are read back in the same bounded hash-checked chunks used for inputs, so large staged roles resume intact. `answers` is incompatible with `attempt`: a resumed in-progress round keeps the answers recorded in its attempt manifest. Retrying `finish` after an interruption is safe — the synthesis role is replaced atomically rather than rejected because a partial write exists.

## Model-group routing

Each voice skill selects its group via `model-group:` frontmatter. The canonical project-scoped groups ship with this repository at `.pi/pi-schematic/model-groups.json` (schema v2) and are read when pi boots from the project root. A consuming project copies that one file into its own `.pi/pi-schematic/model-groups.json` (or runs pi from this repository root directly). The shipped groups:

| Group | Member(s) | Provider | Thinking |
|---|---|---|---|
| `architecture-master` | gpt-6.1-sol | openai-codex | high |
| `architecture-expert` | gpt-6.1-sol | openai-codex | medium |
| `journey-group` | mercury-3 | vercel | high |
| `architecture-model` | glm-5.3-flash | opencode-go | high |
| `architecture-stressor` | deepseek-v4.1-flash | opencode-go | max |

All groups are single-member, so selection is deterministic. Consumers may edit the copy (models/thinking are project policy); a missing file means no groups, and a selector referencing an unknown group blocks the turn.

## Independent voice contexts

Before each of the nine invocations, the workflow calls `workflow.new()` and reasserts readonly mode. Voice definitions stay stable; conversation history does not. Continuity comes only from explicit artifacts, not raw prior conversations or private memory.

Every invocation receives the exact captured source, cumulative human answers and complete current accepted artifacts in `snapshot`. Current-round sharing is limited to:

| Invocation | Additional input |
|---|---|
| Master agenda | None |
| Journey, Model, Stressor exploration | Agenda only; no sibling drafts |
| Expert answer | Agenda and all three proposals |
| Journey, Model, Stressor challenge | Agenda, all proposals and expert answers; no sibling challenges |
| Master synthesis | Agenda, all proposals, expert answers and all challenges |

Shared artifacts are data to assess, not replacement role instructions. A voice must not adopt another voice's persona. Synthesis preserves unresolved dissent and existing evidence, human-checkpoint and immutable-persistence requirements.

Fresh contexts are not a security sandbox, statistical independence or parallel execution. All nine invocations remain serial. The layout has not been live-qualified; offline checks cannot establish model accuracy or persona adherence.

## Human operator interface

- Checkpoints after each committed round expose `latest_snapshot`, `round`, and `disposition` — `continue`, `needs-human` (answer blocking questions), or `candidate` (milestone acceptance)
- Open questions are durable and immutable: a reworded question gets a new ID plus an explicit history link
- `needs-human` is a design-input gate, not a request for a live operational responder

## Supported invocation topologies

- Installed project: run `node /path/to/ddd-iteration/install.mjs` from the target project root; the workflow appears in the `/workflows` TUI list and is invocable as `/workflow architecture-iteration ./workshop.json` there
- Canonical source: use `/workflow ./architecture-iteration.js ./workshop.json` from this repository root; voice skills must still be discoverable (run `node install.mjs` there)

Global paths and arbitrary-path launches are unsupported by design: the workflow preflight requires the fixed installed project copy or the canonical source root, and `artifacts.mjs` must sit beside the workflow entry.

## Development

```bash
node --test test/*.test.mjs # headless test suite
node install.mjs --dry-run # installer preflight
```

CI runs tests and a scratch-project dry-run on every push/PR.

## License

MIT (see LICENSE).
