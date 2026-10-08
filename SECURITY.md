# Enforcement and trust boundaries

**The kit validates a workflow; it does not authenticate human decisions.**
“Humans own decisions” is an instruction to assistants, not an independently
enforced authorization boundary. Use the kit with cooperative assistants. It is
not a security boundary against a process that can run the CLI, call the local
API, import `Kit`, or write the kit's files.

## Enforced guarantees and instruction-only controls

These checks assume unmodified kit code and playbooks and actions performed
through the relevant methods. Direct filesystem writes are outside them.

| Control | What is enforced | What is not guaranteed |
|---------|------------------|------------------------|
| `task next` | Validates required output sections and claims format; stops at `awaiting-review` | Truth of claims or that only a human can release the stop |
| `task review` / `Kit.review()` | Requires `awaiting-review`, approve/reject, and a note for rejection | Caller identity, human presence or authorization |
| `task skip`, `task wait` | Require a reason / waiting target and reject completed tasks | Human authorization |
| AGENTS.md and assistant pointers | Instructions, not executable access controls | That an assistant will obey them |
| `.claude/settings.json` `ask` rules | Claude Code configuration requesting approval for matching Bash commands when honored by that host | Protection of Copilot or other assistants, direct CLI/API calls, imports or file writes; complete mediation even within Claude Code |
| Local UI | Loopback binding, Host/Origin and JSON content-type checks | Authentication of local callers or proof that `via: ui` means a person clicked |
| History and `watch` | Kit methods append events; `watch` matches event type or `via: ui` | Authenticated authorship, tamper resistance, or human action when the watcher wakes |

`by` is a label read from Git configuration (with environment fallbacks), not an
authenticated principal. A caller can supply that configuration. `via` identifies
the code path, not the caller. History is an ordinary list in writable YAML;
committed Git diffs aid inspection but do not prevent direct edits or prove who
made a decision. “Append-only” describes the kit methods, not protected storage.

## Reproduce the open gap

Baseline: PR #1, commit `a1ce73f71832bc7c35406e55940c77617ca2ee9b`.
Reproduced on 2026-10-08 with the regression/characterization suite:

```sh
npm ci
node --test tests/human-gate.test.js
```

Each case creates a disposable kit with the shipped playbooks and Claude Code
settings. The test starts the real CLI as a child process with stdin closed and
no terminal, fills synthetic stage output, and reaches `root-cause` /
`awaiting-review` through `task next`. It supplies the Git name
`unverified-test-reviewer` through process configuration, without modifying the
user's Git configuration. It then invokes the decision command without any
interactive human approval and reloads `task.yaml` to verify both the persisted
state and the exact appended event. Temporary files are removed after each case.
No existing task or product repository is used.

All rows start at `root-cause` / `awaiting-review`:

| Programmatic command | Persisted result | Appended history event |
|----------------------|------------------|------------------------|
| `task review gate-probe approve` | `fix` / `in-progress` | `approved` |
| `task review gate-probe reject --note "Automated probe"` | `root-cause` / `in-progress` | `rejected` |
| `task skip gate-probe --reason "Automated probe"` | `fix` / `in-progress` | `skipped` |
| `task wait gate-probe --on "Automated probe"` | `root-cause` / `waiting` | `waiting` |

Each event records `by: unverified-test-reviewer`, `via: cli`, and
`stage: root-cause`. Earlier history remains unchanged. Negative controls verify
that approval outside `awaiting-review` and an invalid decision fail without
changing the file, and that `task next` alone cannot release a pending review.

These passing tests deliberately characterize an **unresolved authorization
gap**, not a security fix. They prevent the documented limitation from becoming
an untested claim. Once independent authorization is implemented, replace the
unattended-success expectations with denial plus unchanged-state/history
assertions, and add an authenticated approval case. This controlled reproduction
does not demonstrate an exploit by any particular AI assistant and does not test
Claude Code's permission matching. Existing API tests also demonstrate scripted
approval with `via: ui`; that label cannot serve as an alternative trust anchor.

## Why no local authorization patch

A confirmation flag, environment variable, TTY check, Git name or token readable
by the agent would still be controlled by the same process. Restricting only the
CLI would leave `Kit`, the API and direct file writes available. Those changes
cannot reliably distinguish a person from an agent with the same access.

Reliable human authorization needs an independent trust anchor: an approval
credential or interaction the agent cannot exercise, bound to the task, stage,
decision and reviewed content, plus a trusted verifier/state writer the agent
cannot bypass or modify. A signature alone is insufficient if its key or the
accepted task state remains under the agent's control. That requires a change
to the current shared-files trust model and is outside this bounded change.
Q1-Q3 in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) remain open. No new gateway,
approval service or assistant-specific authorization mechanism is introduced.
