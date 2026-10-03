# Onboarding

From install to your first review in about an hour.

## 1. Install (5 minutes)

You need Node 20 or newer and git.

```
npm ci
node kit.js doctor
```

`doctor` prints a fix for every failure. Set your git name if it asks: `git config --global user.name "Your Name"`.

## 2. Describe your repos (10 minutes)

Edit `repos.yaml`. Add one entry per product repo: name, URL, owner (`ours` or another team), purpose, production branch. Then:

```
node kit.js repos clone
node kit.js repos where
```

Repos land in `repos/<name>`, or in `$KIT_REPOS_DIR` if you set it. `node kit.js repos workspace` writes a VS Code multi-root file.

## 3. Read the rules (5 minutes)

Read [AGENTS.md](AGENTS.md). Open your assistant in this folder. It loads AGENTS.md through its own pointer file.

## 4. Start a task (10 minutes)

```
node kit.js task new PROJ-123 --type bug --title "Short title" --repos my-repo
node kit.js task status PROJ-123
```

Or type `/task new` in Claude Code or Copilot.

## 5. Work the stages (20 minutes)

Type `/task PROJ-123`. The assistant reads `task status`, does the stage, and runs `task next`. `next` refuses incomplete output and lists every problem.

## 6. Review (10 minutes)

At a review stop, read the output file. Inferred claims are the first thing to question. Then decide:

```
node kit.js task review PROJ-123 approve
node kit.js task review PROJ-123 reject --note "what is wrong"
```

Or use the web UI: `node kit.js ui`. To be woken when you act, the assistant can run `node kit.js watch PROJ-123` in the background.

## 7. Fill in the KB

Every playbook ends with a learn stage. Add pages under `kb/` following [the schema](kb/_meta/schema.md), link them from [the index](kb/README.md), and run `node kit.js check`.

## 8. Before you commit

```
npm test
node kit.js check
```

Commit task folders. They are the audit trail.
