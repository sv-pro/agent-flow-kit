# Tools

Read-only investigation tools: scripts that query logs, databases or APIs.

Rules:

- Read-only. No tool writes to production.
- Secrets live only in a git-ignored `.env` next to the tool (`tools/<tool>/.env`). Never commit them.
- Each tool has a short README: what it reads, how to run it, what it prints.
- Cite the exact command as the anchor of a measured claim.
