Order of operations, plain English:

Read SETUP.md once, top to bottom. Don't skip ahead.
Create the milestone and labels on GitHub (5 minutes).
Drop the two SKILL.md files into .claude/skills/demo-build/ and .claude/skills/fine-tuning/ in your repo, commit, push.
Create the 8 issues in GitHub by copy-pasting from SETUP.md. Assign milestone + labels.
Work them one at a time. For each: branch → paste the Claude prompt → verify → PR → merge → next.

The critical sequencing for tonight:
Issues 1–6 are the demo itself and must be done while you're awake. Issue 7 (overnight fine-tuning) you kick off right before bed — it runs while you sleep. Issue 8 you do tomorrow morning before judges arrive.
A few things I want to flag honestly:

The model toggle pattern (one env var, two files) means even if overnight fine-tuning produces garbage, your demo is unaffected. That's the whole point.
Issue #6 (backup video) is labeled demo-critical for a reason. Do not skip it. Wifi at demos fails roughly 30% of the time in my mental model — be the team that has the video ready.
The 8 issues are sized so each should take 30–90 minutes with Claude Code doing the heavy lifting. If one is taking 3+ hours, the issue is too big — stop, ask me to break it down further.
