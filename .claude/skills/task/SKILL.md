---
name: task
description: Work a playbook task. Use for "/task", "/task KEY" and "/task new ...".
---

Run the task loop. Follow what the CLI prints. The rules are in AGENTS.md.

1. `/task` alone: run `node kit.js task list` and show the result. Stop.
2. `/task new ...`: run `node kit.js task new <KEY> --type <type> --title <text> [--repos a,b] [--from KEY]`. If the key, type, title or repos are missing, ask for them first. Do not guess.
3. `/task <KEY>`: run `node kit.js task status <KEY>`, then act on the state:
   - Rejection note shown: handle it first.
   - `awaiting-review`: summarise the inferred claims in the output file and stop. Do not approve.
   - `blocked`: meet the requirement with real evidence (`node kit.js task meet <KEY> <requirement> --evidence "..."`), or ask the human for the link.
   - `waiting`: say what it waits on. Stop.
   - `in-progress`: do the stage's work, staying inside the stage. Write the output file. Run `node kit.js task next <KEY>`. Fix every problem it lists and run it again.
   - `done`: say so.
4. Report one line: the outcome of `next`. Stop unless told to continue.

Never run `task review`, `task skip` or `task wait`. Those belong to the human.
