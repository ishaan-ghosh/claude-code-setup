---
description: Run a human-in-the-loop audit workflow
argument-hint: "<commit|diff|staged|pr|stack> [target]"
---
Use the `audit-flow` skill to run an explicit human-in-the-loop audit. This session is the sole orchestrator for the audit directory: only it runs the helpers and writes `audit.yml`, prompts, synthesis, and final artifacts. Reviewers and verifiers never write those or each other's reports.

Run the primary-reviewer automation now:
1. Use `${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs` to compose the selected repo profile, bind every selected repository to a `git-worktree-v2` snapshot, create the neutral `.audit/local/audits/<audit-id>/` workspace (the legacy `.claude/local/audits/<audit-id>/` fallback applies only to repos with legacy `.claude/` audit state and no `.audit/`), and generate the primary, blind-peer, and final-diff prompts. PR/stack runs must supply explicit, distinct `--base`/`--head` refs unless every repo entry already does. (If `${CLAUDE_PLUGIN_ROOT}` is unset because the skill is running from a checkout, substitute the absolute path to the `audit-flow` skill directory.) No repo setup is needed: in a repo without `.audit/`, `.claude/`, or `CLAUDE.md`/`AGENTS.md`, the built-in profiles are used and, if the neutral artifact directory is not already ignored, the helper appends `/.audit/local/` to the repo's local `.git/info/exclude` (via `git rev-parse --git-path info/exclude`) before capturing the snapshot and records this under `artifact_exclude` in `audit.yml`. Pass `--no-auto-exclude` if the user does not want the exclude file touched; the helper then fails with instructions to ignore `.audit/local/` manually.
2. Launch a fresh read-only reviewer with the Agent tool (`subagent_type: dev-setup:reviewer`, pinned to opus), passing the generated `primary-reviewer-prompt.md` as its task, and save its returned report to `primary-initial.md`.
3. Run `${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool <tool> --model <model> --session-id <unique-id>` to update `audit.yml` with structural orchestrator-attested provenance.
4. Report `peer-review-prompt.md` for the peer run without disclosing the audit directory, primary artifact, or its path. The generated peer prompt omits repository-controlled fragments. Save and record the peer with its own nonempty tool/model/session identity before any optional comparison; a comparison must be a separate prompt, artifact, and dispatch ID.
5. Apply the two-reviewer finding gate. Give each focused verifier a saved nonempty prompt and launch one fresh Agent run per prompt (`subagent_type: dev-setup:audit-verifier`, pinned to opus), then record it with `--stage verification --reviewer-key <key> --prompt verification-<name>-prompt.md --artifact verification-<name>.md --tool <tool> --model <model> --session-id <unique-id>`.
6. Run the separate whole-target adversarial prompt after primary and peer in a distinct, fresh reviewer run (`subagent_type: dev-setup:reviewer`; never resume the primary run), then record `final-diff-review.md` with `--stage final-diff` and complete identity fields. This stage is not automatically a finding verifier.
7. After writing valid `findings.json` and nonempty `receipt.md`, run `finalize-audit.mjs --audit-yml <auditYmlPath> --status <passed|passed_with_deferred|blocked>`. Any target or artifact drift requires a new audit rather than overwriting provenance.
8. Only after finalization and human approval of the fix scope, launch the fix writer (`subagent_type: dev-setup:worker`, pinned to opus) with accepted findings only, then start a follow-up audit of the resulting diff. Committing (unless already authorized), pushing, merging, tagging or releasing, and posting GitHub comments need explicit human approval.

Reports must list exact validation commands and observed results; unverified claims stay open questions.

The metadata and digest checks are local structural attestations. Do not claim they cryptographically prove authorship, independent cognition, direct inspection, or peer blindness.

Audit request:
$ARGUMENTS
