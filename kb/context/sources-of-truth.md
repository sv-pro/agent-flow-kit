---
kb_id: context-sources-of-truth
title: Sources of truth
status: draft
last_reviewed: 2026-01-01
source_anchors: []
---

# Sources of truth

Which source answers which question. Fill in the table for your environments.

| Question | Source | Notes |
|----------|--------|-------|
| What does the code do in an environment? | The branch that environment runs, in the repo | Check out and pull it first. Run `node kit.js repos where`. |
| What did a user actually get? | Production data, read-only | Needs the data-access requirement. |
| What was asked? | The ticket and all its comments | The report, not a summary of it. |
| What is the process? | `playbooks/` and the `task status` output | Not an agent's habits. |

## Known from code

Nothing recorded yet.

## Inferred

When the KB and the code disagree, the code wins and the page gets fixed.
