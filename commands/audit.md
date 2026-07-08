---
description: Run a human-in-the-loop audit workflow
argument-hint: "<commit|diff|staged|pr|stack> [target]"
---
Use the `audit-flow` skill to run an explicit human-in-the-loop audit.

Run the primary-reviewer automation now:
1. Use `${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs` to compose the selected repo profile, create `.claude/local/audits/<audit-id>/`, and generate `primary-reviewer-prompt.md` plus `peer-review-prompt.md`. (If `${CLAUDE_PLUGIN_ROOT}` is unset because the skill is running from a checkout, substitute the absolute path to the `audit-flow` skill directory.)
2. Launch a fresh read-only reviewer with the Agent tool (`subagent_type: reviewer`), passing the generated `primary-reviewer-prompt.md` as its task, and save its returned report to `primary-initial.md`.
3. Run `${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool claude-subagent` to update `audit.yml` with primary-reviewer provenance.
4. Report the audit directory and the `peer-review-prompt.md` path for the next semi-manual peer-review step.

Audit request:
$ARGUMENTS
