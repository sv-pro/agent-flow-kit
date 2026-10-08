# Open questions

Known gaps and undecided points. IDs are stable; do not renumber.

Q1-Q3 remain unresolved. The unattended CLI reproduction and the distinction
between workflow checks and human authorization are in [SECURITY.md](SECURITY.md).
Run `node --test tests/human-gate.test.js` to reproduce the state/history changes
on disposable tasks; passing tests characterize the gap, not its closure.

| ID | Question | Status |
|----|----------|--------|
| Q1 | The `ask` permission rules in `.claude/settings.json` apply only to matching commands mediated by Claude Code. CLI/API/Kit methods do not authenticate callers. Programmatic review, skip and wait change state/history without human interaction. Human authorization needs an independent trust anchor and protected state writer. | open; reproduced 2026-10-08 |
| Q2 | `via: ui` is recorded by the UI process. An agent can call the UI API or edit `task.yaml` directly. Git history shows it, but nothing blocks it. | open |
| Q3 | `by` is the git user name. It is not authenticated. | open |
| Q4 | `task wait` does not remember the state it left (for example `awaiting-review`). `resume` returns to `in-progress`, or `blocked` if a requirement is unmet. | open |
| Q5 | Skipping a stage leaves its template file unfilled. Should `check` flag skipped stages differently? | open |
| Q6 | Anchors in the KB name a path, not a symbol, so a renamed symbol is not detected. | open |
| Q7 | A runner that executes playbooks needs a way to call a model and to run the human gates. Not designed. | open |
| Q8 | Two people changing the same task at once is resolved by git merge only. | open |
