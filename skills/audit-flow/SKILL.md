---
name: audit-flow
description: Orchestrate human-in-the-loop code and PR audits with repo-local prompt profiles, isolated reviewer sessions, cross-model peer review artifacts, and final fix or GitHub review handoff. Use before committing, pushing, merging, or submitting PR review feedback.
---

# Audit Flow

Use this skill to run explicit, human-approved audits before commits, pushes, merges, or PR review feedback.

## Core model

- Use a parent orchestrator plus separate reviewer sessions.
- The parent Claude Code session is the audit cockpit: select the target, compose the profile, manage artifacts, synthesize reviewer outputs, support interactive human drill-down, and record final accepted findings.
- Reviewer sessions are isolated and provenance-preserving. Launch them with the Agent tool using the bundled `reviewer` subagent (read-only). They inspect the target directly, run validation when useful, and may write audit artifacts, but they must not edit application code.
- Fixing is a separate pass after human acceptance of findings, handled by a writer/worker session scoped to accepted findings only.
- The live, resumable audit session is the canonical human approval checkpoint. Files are durable receipts and handoff artifacts generated from the live discussion.

## Repo conventions

See `PROFILE-SCHEMA.md` for the lightweight v1 profile schema convention, `FINDINGS-SCHEMA.md` for the structured finding/status convention, and `AUDIT-METADATA.md` for `audit.yml` metadata. Treat these as documentation, not strict validators, until the workflow stabilizes.

Tracked repo-specific audit inputs live under:

```txt
.claude/audit/
  profiles/*.yaml
  prompts/*.md
```

If a repo does not define a requested profile, the v1 helper falls back to generic built-in `commit` and `pr` profiles bundled with this skill. Repo-local profiles override built-in defaults.

Prompt/profile changes that are generally useful for a repo should go through normal review and be committed. One-off, secret, machine-specific, or experimental prompt changes belong under `.claude/local/audit-experiments/`. Audit artifacts should record the tracked profile/fragments and any local overrides used.

Generated/private artifacts live under gitignored:

```txt
.claude/local/audits/<audit-id>/
```

The v1 helper refuses to write artifacts inside a git repository unless the artifact path is ignored, unless the human explicitly passes `--allow-unignored-artifacts`. Prefer adding `.claude/local/` to `.gitignore` or `.git/info/exclude`.

Do not commit `.claude/local/` artifacts unless the human explicitly requests moving distilled context into tracked docs.

## Privacy and secrets

Treat audit artifacts as local/private by default. Do not put secrets, tokens, private endpoints, raw payloads, customer data, or sensitive logs into tracked prompts, PR notes, review comments, or receipts. Receipts should summarize validation without sensitive output. If sensitive evidence is necessary for a finding, keep it in local artifacts and say that sensitive evidence was reviewed locally.

## Audit types

- Commit Audit: review a local diff unit before it becomes committed or pushed history, such as unstaged changes, staged changes, or a commit/range.
- PR Audit: review a pull request as the reviewable integration unit, including full diff against base, PR claims, affected contracts/tests/docs, and stacked-PR context when relevant.
- Multi-repo Platform Audit: review multiple repositories that are parts of the same product/platform, such as a backend repo and frontend repo for one platform. Keep this lightweight: one platform context root, named member repo roots/roles, and required first steps are enough for v1. Do not broaden an audit across unrelated platforms unless the human explicitly scopes that unusual case.

Profiles are human-editable. Tracked profiles should prefer portable relative paths and environment-variable placeholders. Machine-specific path overrides belong in gitignored `.claude/local/audit.overrides.yaml`, not tracked prompt/profile files. Resolve paths in this order when possible: explicit audit argument, local override, environment variable, tracked profile default, current repo-relative path.

For v1, audit coverage applies to the diff entering the branch rather than to every final commit object. It is acceptable to amend, squash, or reorder commits after a local audit as long as meaningful resulting changes are re-audited before push or PR review. Before pushing or opening a PR, audit the outgoing branch or PR as a whole.

PR audits should understand stacked branches. Use the PR base branch as the default comparison base for the current review unit, not `main`, unless explicitly requested. Separate inherited parent findings, child-specific findings, and merge-order/base-update risks. Re-fetch and record observed base/head refs when reviewing remote PRs.

Both audit types use the same lifecycle:

```txt
candidate finding → peer-reviewed finding → human accepted/rejected → fix, review comment, or defer
```

## Validation command policy

Audit agents may run safe, targeted read-only or validation commands automatically when they materially improve confidence. Examples include `git status`, `git diff`, `gh pr view`, targeted tests, linters, typechecks, config/schema checks, and read-only migration graph inspection.

Require explicit human approval before expensive, stateful, hardware, network-mutating, or destructive commands. Examples include physical robot runs, database/service mutation, Docker compose lifecycle commands unless pre-approved by the profile/session, posting GitHub comments, committing, pushing, long Isaac/GPU runs, commands touching secrets, and external production-system operations.

## V1 cross-model validation

Use generic reviewer roles in schemas, artifact names, and summaries. Record actual model/tool names in `audit.yml` metadata, not in canonical artifact filenames. This keeps the flow open to different primary and peer reviewers over time.

Use semi-automated peer-review handoff in v1:

1. The orchestrator produces the initial audit and peer-review-ready prompt/artifact.
2. The human explicitly launches or approves the peer reviewer.
3. The human or a later helper writes peer-review output back into the audit artifact directory.
4. The orchestrator ingests/synthesizes the peer review.

A natural cross-model peer reviewer is a second harness or model — for example, run the peer review with a different provider via its own CLI, or in a separate Claude Code session pinned to a different model.

## Suggested artifact set

```txt
.claude/local/audits/<audit-id>/
  audit.yml
  primary-reviewer-prompt.md
  primary-initial.md
  primary-findings.json
  peer-review-prompt.md
  peer-review.md
  synthesis.md
  final-human-reviewed.md
  findings.json
  final-plan.md
  receipt.md
```

Use Markdown for human review and JSON/YAML for later automation.

## Minimal v1 helpers

Use `scripts/start-audit.mjs` to compose a tracked profile, create the local artifact directory, write `audit.yml`, and write `primary-reviewer-prompt.md` plus `peer-review-prompt.md`.

Resolve the script path relative to this skill directory. When this skill is installed as part of a plugin, the skill directory is `${CLAUDE_PLUGIN_ROOT}/skills/audit-flow`. Example from a repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" --profile pr --target "PR #14"
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" diff
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" staged
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" pr "PR #14"
```

If `${CLAUDE_PLUGIN_ROOT}` is not set (for example, running the skill from a checkout rather than an installed plugin), substitute the absolute path to this skill directory.

The helper prints JSON containing `auditDir`, `auditYmlPath`, `primaryPromptPath`, `primaryInitialPath`, `peerPromptPath`, and related artifact paths. Common positional commands map to profiles: `diff`, `staged`, and `commit` use the `commit` profile; `pr` and `stack` use the `pr` profile.

Use `scripts/record-stage.mjs` after a reviewer artifact has been written to record completion metadata in `audit.yml`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/record-stage.mjs" --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool claude-subagent
```

## Primary reviewer automation

Do not stop after generating prompts. Launch the primary reviewer automatically:

1. Run `start-audit.mjs` for the requested profile/target.
2. Launch a fresh reviewer with the Agent tool, `subagent_type` set to `reviewer` (the read-only reviewer bundled with this plugin), passing the contents of `primary-reviewer-prompt.md` as the task. Instruct it to operate in the audited repo root and to return the full audit report as its final message.
3. The reviewer must not edit application code.
4. Save the reviewer's returned report to `primary-initial.md`, then run `record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool claude-subagent`. Record model/session IDs only if you have them.
5. Tell the human where `primary-initial.md` and `peer-review-prompt.md` were written, and pause for the semi-automated peer-review step.

If launching a subagent is not possible, perform the primary review in the parent session, write the result to `primary-initial.md`, then run `record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool claude-parent`.

## Orchestration outline

1. Read repo instructions: `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `CONTRIBUTING.md`, and `docs/adr/*.md` when present.
2. Identify audit type, target, base/head refs, and current git cleanliness constraints.
3. Run the minimal v1 start helper for the selected profile and target.
4. Launch the primary reviewer automatically and save its report to `primary-initial.md`.
5. Run `record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath>` to update `audit.yml`.
6. Pause for or ingest peer-review output into `peer-review.md`.
7. Synthesize disagreements and candidate findings.
8. Keep the parent session live for human drill-down.
9. After human confirmation, write final accepted/rejected/deferred findings and a fix or PR-review plan.
10. Only then run a fixing agent or generate GitHub review comments.
11. After fixes, run targeted verification and re-audit the changed lines or accepted-finding area before committing/pushing.
12. Mark every accepted finding as `fixed`, `partially_fixed`, `still_open`, or `verified` before closing the audit.
13. Produce a compact `receipt.md` suitable for PR notes without exposing raw local transcripts.

## Audit receipt

A completed audit should write `receipt.md` under the audit artifact directory. Include audit type and target, profile/fragments used, reviewer sessions/models used when known, whether peer review was included, human accepted/rejected/deferred counts, fixes or review comments generated, validation commands/results, residual risks, and final status: `passed`, `passed_with_deferred`, or `blocked`.

## Review/fix separation

Reviewer sessions are read-only with respect to application code. They may create audit artifacts under `.claude/local/audits/` and run validation commands, but must not modify source, tests, docs, configs, migrations, or generated committed assets. A separate fix pass may edit code only after the human accepts findings and approves the fix scope. For local work, offer both a generated `fix-prompt.md` and an orchestrated fix pass; default to launching a separate writer session (the Agent tool with a general-purpose subagent, or a fresh Claude Code session) after the human approves the final fix plan. The writer must fix only accepted findings, ignore rejected/deferred findings, run targeted validation, and return a summary/diff for post-fix verification. After a fix pass, show the resulting diff, verify each accepted finding is addressed or explicitly still open, run targeted validation unless impossible, and update statuses before producing the final receipt. For coworker PRs, generate review comments from accepted findings instead of fixing unless the human explicitly asks to make changes on a branch.

## GitHub PR review comment policy

Post only human-accepted findings. Accepted confirmed findings with exact diff anchors become inline GitHub review comments. Accepted PR-level findings without stable line anchors go in the review body. Open questions are posted only when the human explicitly approves asking them. Optional suggestions are not posted by default. Rejected findings are never posted. Deferred findings usually become local follow-up issues or notes rather than PR comments unless they directly affect the reviewed PR.

In v1, prepare a GitHub review packet instead of directly posting externally visible comments. The packet may include `github-review-packet.md`, `github-review-comments.json`, and `peer-github-review-prompt.md` under the audit artifact directory. The human reviews the packet, then an approved peer agent or the human posts it with `gh`. Direct posting can be added later after comment anchoring and approval UX are proven.

## Output standards

Findings first, ordered by severity. Confirmed findings need exact file/line references, impact, and evidence. Separate confirmed findings, open questions/assumptions, optional suggestions, and residual validation gaps.
