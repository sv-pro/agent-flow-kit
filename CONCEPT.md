# Concept

## Problem

Assistants work well on a task but differently each time. They skip steps, approve their own work, state guesses as facts, and forget what they learned. Teams get inconsistent results, and nobody can see why a task ended up where it did.

## Idea

Put the process in files and enforce it with one small CLI. Playbooks define stages, outputs and where a human decides. The CLI prints what to do now and refuses output that is incomplete. Assistants follow the CLI.

## Principles

1. The process lives in files. Agents follow what the CLI prints, never their own habits.
2. Humans own decisions. An agent must do a stage's work and stop for review; it must not approve, skip or park a task. This is an instruction-only rule in the current implementation, not authenticated authorization (see [SECURITY.md](SECURITY.md)).
3. Every claim says how it is known: measured (with an anchor someone else can re-run), inferred, or decision. The CLI validates this.
4. Knowledge is captured where it is found. Every playbook ends with a learn stage that updates the KB.
5. No platform. Files, git and one Node script. No server, no database, one runtime dependency (`yaml`).
6. One rules file for every assistant. `AGENTS.md` is canonical. Other files point to it.
7. Built to grow: a later runner can execute the same playbooks without a redesign.

## Features

| ID | Feature | Status |
|----|---------|--------|
| F1 | Playbooks with shared stages, templates, gates, requirements, claims | built |
| F2 | Task lifecycle: new, status, next, review, meet, wait, resume, skip, `--from` | built |
| F3 | Output validation: required sections, no empty or placeholder sections | built |
| F4 | Claims validation: kinds, anchors on measured rows | built |
| F5 | `repos` commands: where, clone, status, pull, workspace | built |
| F6 | `check`: playbooks, tasks, KB front matter, index links, relative links, personal paths | built |
| F7 | `doctor` with a fix for each failure | built |
| F8 | One rules file plus pointers for Claude Code and Copilot, `/task` loop | built |
| F9 | Permission rules requesting approval for matching review, skip and wait commands (Claude Code only) | configuration shipped; not a cross-assistant boundary |
| F10 | Local web UI over the same actions, `via: ui` recorded | built |
| F11 | `watch`: wakes on matching decision/UI events; caller is not authenticated | built |
| F12 | Seed KB and CI | built |
| F13 | Runner that executes playbooks without an assistant | planned |
| F14 | Ticket and wiki drafts published by a human-approved step | planned |
| F15 | Human authorization with an independent trust anchor and protected state writer | planned; Q1-Q3 remain open |
| F16 | Task dashboard across many tasks and repos | planned |

## Roadmap

1. Now: F1-F12.
2. Next: F15, then F14.
3. Later: F13 and F16, using the same playbook files.

## 5-minute demo

Run on a fresh clone after `npm ci`. Replace the repo list in `repos.yaml` first if you want repos in the task; the demo needs none.

```
node kit.js doctor
node kit.js task new demo-bug --type bug --title "Demo: export fails"
node kit.js task next demo-bug
```

`next` refuses the empty intake and lists every missing section. Fill in `tasks/demo-bug/01-intake.md`, then:

```
node kit.js task next demo-bug
```

The task moves to `reproduce`. Fill in `02-reproduce.md` and run `next` again. At `root-cause`, add a claim like this to the Claims table:

```
| Claim | Kind | Anchor |
|-------|------|--------|
| The export drops empty rows | measured | |
```

`next` rejects it: a measured row needs an anchor. Add an anchor (a command or test) and run `next` again. The task stops for review (`awaiting-review`). The agent is instructed not to continue; the review command itself does not authenticate its caller. As the human:

```
node kit.js task review demo-bug reject --note "Show the failing test in the anchor"
node kit.js task status demo-bug
```

`status` shows the rejection note first. Fix the output, run `next`, then approve:

```
node kit.js task review demo-bug approve
```

`tasks/demo-bug/task.yaml` now shows the whole trail: created, advanced, review-requested, rejected, review-requested, approved. Each event has the time (UTC), the git user, and `via`.
