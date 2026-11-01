# ddd-iteration

A standalone, artifact-driven domain-design iteration workflow for [pi](https://pi.dev). Five voices — Journey, Model, Stressor, Expert, Master — converge over rounds of evidence-disciplined exploration and challenge, producing structured DDD-style architecture artifacts gated by human answers and immutable snapshots.

This is the released form of the `architecture-iteration` package. Discovery entries in a consuming project are symlinks into this repository: one source of truth, no maintained copies.

## Dependencies

- **pi host** — the runtime that loads and runs the workflow. Developed against pi v1.4.0; any current 1.x should work, but pin what you validated.
- **pi-schematic plugin** — provides `model-group:` frontmatter routing used by the five voice skills. Install the plugin from the branch currently validated by this package:
  - repository: `https://github.com/chunkhound/pi-schematic` (installed agent copy)
  - branch: `fix/36` — commit `aa9b325` — version `0.7.0`
  - Install per pi-schematic's own instructions (plugin checkout under the pi agent directory, `git` layout as documented there). Do not rely on an npm-published copy: routing parity is validated against this pinned branch.
- **model-groups config** — each consuming project must define the five groups under `.pi/pi-schematic/model-groups.json` (schema v2). See **Model-group routing** below.
- Node.js 24 is used in CI; the artifact engine and installer use only Node built-ins (no external packages).

## What you get

- A 9-turn round (agenda → explore ×3 → expert answer → challenge ×3 → synthesis) orchestrated as a pi workflow
- Five canonical voice skills (`architecture-iteration-{master,expert,journey,model,stressor}`) for route model-group selection
- A deterministic artifact engine (`artifacts.mjs`): JSON-schema validation, SHA-256 snapshot lineage, question resolution, recover/inspect, and chunked transport (45 KiB shell packets, 4000-char chunks)
- A symlink installer (`install.mjs`) with strict no-overwrite/no-delete preflight
- No external npm dependencies; headless tests in `test/`

## Install into a project

```bash
git clone https://github.com/<owner>/ddd-iteration ~/ddd-iteration
cd /path/to/your/project
node ~/ddd-iteration/install.mjs
```

The current working directory is the project — there is nothing else to decide. Start pi from this directory and reload resources after installation. The installer links:

- `.pi/workflows/architecture-iteration.js` → canonical `architecture-iteration.js`
- `.pi/skills/architecture-iteration-<voice>` → canonical skill directories

Run `node install.mjs --help` for flags. `--dry-run` checks everything without writing. Rerunning is safe and idempotent (links are reported `existing`).

## Run the workflow

From the installed project root:

```text
/workflow architecture-iteration ./workshop.json
```

Configuration (one JSON file path, optionally quoted):

- Start: `{ "document": "strategy.md", "output": "workshop-artifacts", "max_rounds": 3 }`
- Resume: `{ "resume": "workshop-artifacts/round-0001.json", "max_rounds": 3, "answers": "answers.json" }`

`max_rounds` is an integer in 1..8 (default 3). Resume accepts explicit human answers as `[{ "question_id": "Q1", "answer": "..." }]`; unknown/duplicate IDs are errors. Answers become attributed human evidence (`human:Q1:r1`), never model claims.

## Model-group routing

Each voice skill selects its group via `model-group:` frontmatter. Create a project `model-groups.json` under `.pi/pi-schematic/` (schema v2) with the five groups: `architecture-master`, `architecture-expert`, `journey-group`, `architecture-model`, `architecture-stressor`. A group picks a member at random per invocation; keep members' thinking levels comparable for consistent behavior. See the pi-schematic docs for schema details.

## Human operator interface

- Checkpoints after each committed round expose `latest_snapshot`, `round`, and `disposition` — `continue`, `needs-human` (answer blocking questions), or `candidate` (milestone acceptance)
- Open questions are durable and immutable: a reworded question gets a new ID plus an explicit history link
- `needs-human` is a design-input gate, not a request for a live operational responder

## Supported invocation topologies

- Installed project symlink (`install.mjs --project ...`), started from that project root — required for routing and discovery
- Direct canonical invocation from this repository root (`node .../architecture-iteration.js <config>`)

Copies, global paths, and arbitrary-path launches are unsupported by design: the workflow preflight requires the fixed project link or the canonical source root, and `artifacts.mjs` must remain a regular file beside the canonical workflow.

## Development

```bash
node --test test/          # headless test suite
node install.mjs --dry-run # installer preflight
```

CI runs tests and a scratch-project dry-run on every push/PR.

## License

MIT (see LICENSE).
