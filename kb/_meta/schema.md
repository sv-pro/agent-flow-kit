---
kb_id: meta-schema
title: KB page schema
status: reviewed
last_reviewed: 2026-01-01
source_anchors: []
---

# KB page schema

Every page except `kb/README.md` starts with front matter and is linked from `kb/README.md`.

## Front matter

| Field | Rule |
|-------|------|
| `kb_id` | Unique id for the page. |
| `title` | Page title. |
| `status` | `draft` or `reviewed`. |
| `last_reviewed` | Date as `YYYY-MM-DD`. |
| `source_anchors` | List of `<repo>:<path>`. May be empty. |

`node kit.js check` verifies that an anchor's repo is in `repos.yaml`. It verifies the path when the repo is cloned. Otherwise it counts the anchor as "not checked".

## Anchors

An anchor names a path. Name the symbol in the text. Never use line numbers: they go stale.

## Body

- One concept per page.
- Keep "Known from code" apart from "Inferred".
- State the rule. No incident stories. One line of example at most.
- Where to put a page:
  - `troubleshooting/`: symptom first.
  - `runbooks/`: procedures.
  - `context/`: environments, sources, people.
  - `entities/`: domain concepts.
  - `code/<repo>/`: how a repo works.
  - `practices/`: how we work.
