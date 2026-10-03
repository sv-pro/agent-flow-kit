---
kb_id: practice-claims
title: Claims
status: reviewed
last_reviewed: 2026-01-01
source_anchors: []
---

# Claims

Every claim in a task output says how it is known.

## Kinds

| Kind | Meaning | Needs |
|------|---------|-------|
| measured | Observed directly. | An anchor someone else can re-run: a command, test, query or file. |
| inferred | Concluded from other facts. | Nothing, but a reviewer will look at it first. |
| decision | A choice a human made. | Who decided, if known. |

`node kit.js task next` rejects a measured claim without an anchor.

## Rules

- A status code is not a cause. Find what produced it.
- One sample is not a rule. Say how many you saw.
- Check reachability before you call a state a bug. If no path leads there, it is not a bug.
- "I could not find it" is not "it does not exist". Say where you looked.
- When the evidence cannot settle a point, write "unknown" and name the test that would.
