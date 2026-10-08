---
kb_id: ts-status-code-without-cause
title: "Example: a report names a status code but no cause"
status: draft
last_reviewed: 2026-01-01
source_anchors: []
---

# A report names a status code but no cause

Symptom: the ticket says "the call returns 500" and stops there.

## Known from code

Nothing yet. Replace this page with a real one from your product.

## Inferred

A status code says where the failure surfaced, not why. The cause sits behind it.

## What to do

1. Get the request id and the UTC time of one failing call.
2. Find the log or trace for that call in the environment that failed.
3. Reproduce it with a test, then record the claim with an anchor. See [claims](../practices/claims.md).
