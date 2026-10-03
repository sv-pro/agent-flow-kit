# AGENTS.md

Rules and workflow for every assistant. This file is canonical.

## What this repo is

A process kit. It has no product code. It holds playbooks (`playbooks/`), the state of each task (`tasks/<KEY>/`), the knowledge base (`kb/`), and one CLI (`kit.js`) that enforces them. Product code lives in other repos, listed in `repos.yaml`.

## How work runs

Follow what the CLI prints, not your own habits.

1. `node kit.js task status <KEY>`: the stage, its instructions, exit criteria, output file and repos.
2. Do the stage's work. Stay inside the stage. Write the result in the output file the status names.
3. `node kit.js task next <KEY>`: it validates the output and lists every problem at once. Fix them and run it again.
4. Reviews, skips and waits belong to the human. Never run `task review`, `task skip` or `task wait`. When a stage needs review, stop and say so. After you ask for a review, you may run `node kit.js watch <KEY>` in the background; it exits when a person acts.

If the status shows a rejection note, handle it first. A blocked task needs a requirement met with real evidence (`task meet`), or ask the human for the link.

## Finding a repo

- Ask `node kit.js repos where <name>`. Never assume a path.
- Search each repo by its absolute path. The repos are git-ignored, so a search from the kit root silently skips them.
- Check the branch first. Check out and pull the branch the environment runs before you read code.

## Rules

- No commit, push or PR unless the human asks in this conversation.
- Production is read-only.
- Ticket and wiki content is drafted in the task folder. Never write it directly.
- Every claim is measured (with an anchor someone else can re-run), inferred, or a decision.
- Read the code the environment runs.
- Other teams' repos are read-only. State the gap and the evidence. Never state their fix or their owner.
- Product-code comments are 1-3 lines. Reasoning goes in the commit message. Never reference the kit from product code.
- No secrets in files, outputs or commits. Secrets live only in git-ignored `.env` files.

## Knowledge

Read `kb/README.md` first. When the KB and the code disagree, the code wins and the page gets fixed. Page format: `kb/_meta/schema.md`.

## Commands

```
node kit.js task list
node kit.js task new <KEY> --type <type> --title <text> [--repos a,b] [--from KEY]
node kit.js task status <KEY>
node kit.js task next <KEY>
node kit.js task meet <KEY> <requirement> --evidence <text>
node kit.js task resume <KEY>
node kit.js repos where [name] | clone | status | pull | workspace
node kit.js check [-v]
node kit.js doctor
node kit.js watch [KEY] [--timeout s]
node kit.js ui [--port N]
```

Human-only: `task review <KEY> approve|reject`, `task skip`, `task wait`.

## Changing the kit

- A new work type is a new folder `playbooks/<type>/` with `playbook.yaml` and `templates/`. Reuse the shared stages in `playbooks/_shared/` with `- use: <id>`.
- Run `node kit.js check` and `npm test` before you propose a commit.
- Keep this file under about 150 lines. Assistant-specific files are short pointers to it.
