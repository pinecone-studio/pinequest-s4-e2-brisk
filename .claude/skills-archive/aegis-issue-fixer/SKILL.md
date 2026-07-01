---
name: aegis-issue-fixer
description: Work through the prioritized audit fixes for the Pinequest / Aegis surveillance codebase, one issue at a time, using a standard GitHub-issue → branch → implement → PR loop. Use this skill whenever the user asks to "fix the next issue", "work issue N", "start the audit fixes", references PROJECT_STATUS.md items, or mentions any of the known problems (committed RTSP credentials, missing ONNX models, the abandonment/littering pipeline not wired into FastAPI, lazy model loading, YAMNet caching, floor/zone fields, FastAPI lifespan migration, .env.example, RTSP process pool, docker-compose). Trigger this even if the user just says "next" in the context of working through these fixes.
---

# Aegis Issue Fixer

A workflow for resolving the audit findings in the Pinequest / Aegis codebase one issue at a time, with consistent GitHub hygiene and safe handling of security-sensitive changes.

The full, prioritized list of all twelve issues — each with its problem statement, acceptance criteria, exact files, and implementation notes — lives in `references/issues.md`. **Read that file first** whenever you start work, then locate the specific issue the user asked for. Do not work from memory of the issue; the reference file is the source of truth.

## Core principle: ground every change in the real code

This codebase has two detection systems, a Next.js layer, and a Python/FastAPI layer that don't share state. It's easy to "fix" something against an imagined structure. So before editing anything:

- Read the actual file(s) named in the issue, in full, before changing them.
- Confirm the structure (field names, function signatures, existing patterns) rather than assuming it.
- When an issue says "mirror the pattern in file X", read file X first and match it.

If what you find on disk contradicts the issue spec, stop and tell the user what's different rather than forcing the spec.

## The standard loop

Every issue follows the same five steps. Run them in order.

### 1. Create the GitHub issue

Use the `gh` CLI. Title and body come from `references/issues.md` for that item. Each issue body must contain: a **Problem** statement, an **Impact** statement, and an **Acceptance criteria** checklist (`[ ]` items copied from the reference). Apply the labels listed for that issue, creating any that don't exist yet with `gh label create`.

### 2. Branch

Start from an up-to-date `main`:

```
git checkout main && git pull
git checkout -b <branch-name-from-reference>
```

Branch names are specified per issue in the reference (e.g. `security/remove-camera-credentials`). Don't invent your own.

### 3. Implement

Follow the implementation notes for that issue. Keep the change scoped to exactly what the issue describes — don't fold in unrelated fixes you notice, because each issue maps to its own PR. If you spot a new problem, mention it to the user so it can become its own issue.

### 4. Verify

Each issue in the reference lists how to confirm the fix (an import check, a manual run, a test). Do it before committing. If a fix can't be verified without model weights or hardware the environment lacks, say so explicitly in the PR description rather than claiming it works.

### 5. Commit, push, open PR

Use the commit message suggested in the reference. Push the branch, then open a PR with `gh pr create` whose body **closes the issue** (include `Closes #<n>`). The PR description should summarize what changed and surface any follow-ups the user must do by hand.

At the end, report three things back to the user: the **issue URL**, the **branch name**, and the **PR URL**.

## Security-sensitive issues need a human-action callout

Some fixes (the committed RTSP password, the committed `.env`) touch secrets that are already in git history. Code changes alone do NOT make these safe. For any such issue:

- **Never** attempt to rewrite git history automatically (no `filter-repo`, no BFG, no force-push). Flag it as a human task in the PR description instead.
- **Always** state plainly that any secret already committed is compromised and must be rotated on the real device/service by a person — the PR does not do this.
- Stop tracking the file (`git rm --cached`) and add an `.example` template, but leave the real file on disk locally.

The reference marks which issues are security-sensitive.

## Ordering and stacking

The reference lists issues in recommended execution order (small security/correctness wins first, then larger feature and refactor work). When the user says "next" without naming an issue, pick the lowest-numbered one that isn't done yet.

If the user is moving fast and earlier PRs aren't merged yet, ask whether they want the next branch cut from `main` (independent PRs) or stacked on the previous branch (dependent PRs). Default to branching from `main` unless an issue's reference notes a real dependency on an earlier one.

## When the user asks for "all of them"

Don't try to do twelve issues in one branch — that defeats the per-issue PR model. Instead, either (a) work them sequentially, pausing after each PR for the user to review/merge, or (b) if they explicitly want it hands-off, work through them in order, cutting each branch from `main`, and give a single summary table of all issue/PR URLs at the end. Confirm which they want before starting a long unattended run.
