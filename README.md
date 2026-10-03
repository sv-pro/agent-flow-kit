# agent-flow-kit

A process kit for AI-assisted dev and support work. Any coding assistant (Claude Code, GitHub Copilot, others) works a task the same way, because the process lives in files and one CLI enforces it.

The repo holds no product code. It holds:

- playbooks: the stages of each kind of work, with their outputs and review points;
- task state: one folder per task, committed to git;
- the team's knowledge base;
- `kit.js`: a single Node script that validates all three.

No server, no database. One runtime dependency (`yaml`). Git is the audit trail. Concept and demo: [CONCEPT.md](CONCEPT.md).

## Getting started

```
npm ci
node kit.js doctor
node kit.js task new PROJ-123 --type bug --title "Short title" --repos my-repo
node kit.js task status PROJ-123
```

Full walk-through: [ONBOARDING.md](ONBOARDING.md). Fill in `repos.yaml` first (product repos, owners, production branch).

In Claude Code or Copilot, type `/task` to list tasks, `/task PROJ-123` to work one, `/task new ...` to start one.

## Work types

| Type | Stages | Review stops |
|------|--------|--------------|
| bug | intake, reproduce, root-cause, fix, code-review, verify, learn | root-cause, code-review, verify |
| support | intake, investigate, answer, learn | investigate, answer |

A new type is a new folder under `playbooks/`. Reuse the shared stages (`intake`, `learn`) with `- use: <id>`.

## Layout

```
AGENTS.md            rules and workflow for every assistant (canonical)
CLAUDE.md            pointer to AGENTS.md
.github/             Copilot pointer, /task prompt, CI
.claude/             /task skill, permission rules
CONCEPT.md           problem, idea, features, demo
OPEN-QUESTIONS.md    known gaps
ONBOARDING.md        first hour
kit.js               the CLI
ui.js, ui.html       local web UI
repos.yaml           product repos
playbooks/           _shared/ stages, one folder per work type
kb/                  knowledge base (index: kb/README.md)
tasks/<KEY>/         task.yaml and one file per stage
tools/               read-only investigation tools
tests/               node:test suites
```

## Commands

Run `node kit.js help`. The list is also in [AGENTS.md](AGENTS.md).

## Tests

```
npm test
node kit.js check
```

## Roadmap

See the feature table in [CONCEPT.md](CONCEPT.md) and the gaps in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).
