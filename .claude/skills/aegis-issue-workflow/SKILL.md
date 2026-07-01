---
name: aegis-issue-workflow
description: >
  Use whenever the user asks to work the next AI-pipeline issue, says "next",
  "fix the next one", "start issue N", or references AEGIS_ISSUES.md. Runs the
  standard GitHub issue → branch → implement → verify → PR loop for the
  Models/Client/Server pipeline work. This supersedes the archived
  aegis-issue-fixer skill, which pointed at a different (removed) codebase.
---

# Aegis Issue Workflow

`AEGIS_ISSUES.md` at repo root is the source of truth for what's left to do.
Read it fresh each time you start — don't work from memory of a previous
session's summary of it.

## The loop

1. **Create the GitHub issue** (if not already created) with `gh issue create`,
   title and body from `AEGIS_ISSUES.md`. Apply labels mentioned there
   (`ai-pipeline`, `client`, `server`, `demo-critical`), creating any that
   don't exist yet with `gh label create`.
2. **Branch** from an up-to-date `main`:
   ```
   git checkout main && git pull
   git checkout -b <short-descriptive-name>
   ```
3. **Implement** exactly what that issue describes. Read
   `AEGIS_AI_PIPELINE_ARCHITECTURE.md` and the
   `aegis-pipeline-conventions` skill before writing code, so thresholds,
   the `EvidenceEvent` shape, and the no-shared-imports rule are followed
   without re-deriving them. Don't fold in unrelated fixes you notice along
   the way — mention them to the user instead so they can become their own
   issue.
4. **Verify it actually runs.** If an issue needs infrastructure the sandbox
   doesn't have (a real Lightning AI endpoint, a live camera, a provisioned
   D1/R2 binding), say so explicitly in the PR description rather than
   claiming it works untested.
5. **Commit, push, open PR** with `gh pr create`. Body should include
   `Closes #<n>` and a short summary of what changed. Report back the issue
   URL, branch name, and PR URL.

## Ordering

Work issues in the order listed in `AEGIS_ISSUES.md` unless the user names a
specific one — the D1/R2/route issues (#1–#4) and the Client-side port
(#5–#7) have real dependencies on each other; the Wrangler scaffolding (#8)
can happen in parallel. If the user says "next" without naming one, pick the
lowest-numbered issue that isn't done.

## When the user wants several issues done unattended

Don't batch multiple issues into one branch/PR — each issue is its own PR.
If asked to do several in a row, cut each branch from `main` (not stacked on
the previous one, unless a real dependency requires it), work them
sequentially, and give a single summary table of issue/PR URLs at the end.
Confirm this is what's wanted before starting a long unattended run rather
than assuming.

## If the repo doesn't match the issue

If what you find on disk contradicts an issue's description (a file's been
renamed, a route already exists, `AEGIS_AI_PIPELINE_ARCHITECTURE.md` has since
been updated) — stop and say what's different rather than forcing the issue
as written. The architecture doc and the real code both outrank a stale issue
description.
