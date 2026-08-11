---
name: audit-flow
description: Orchestrate human-in-the-loop code and PR audits with repo-local prompt profiles, isolated reviewer sessions, cross-model peer review artifacts, and final fix or GitHub review handoff. Use before committing, pushing, merging, or submitting PR review feedback.
---

# Audit Flow

Use this skill to run explicit, human-approved audits before commits, pushes, merges, or PR review feedback.

## Core model

- Use a parent orchestrator plus separate reviewer sessions.
- The parent Claude Code session is the audit cockpit: select the target, compose the profile, manage artifacts, synthesize reviewer outputs, support interactive human drill-down, and record final accepted findings.
- Launch separate reviewer sessions with the Agent tool using the bundled read-only `reviewer` subagent. Give each run only its intended prompt and target inputs. Reviewers may run validation and write audit artifacts, but they must not edit application code.
- Fixing is a separate pass after human acceptance of findings, handled by a writer/worker session scoped to accepted findings only.
- The live, resumable audit session is the canonical human approval checkpoint. Files are durable receipts and handoff artifacts generated from the live discussion.

## Repo conventions

See `PROFILE-SCHEMA.md` for the lightweight v1 profile schema convention, `FINDINGS-SCHEMA.md` for the structured finding/status convention, and `AUDIT-METADATA.md` for `audit.yml` metadata. Profiles and findings remain human-editable conventions; reviewer recording and finalization strictly validate the target/provenance fields they consume.

Tracked repo-specific audit inputs live under:

```txt
.audit/
  profiles/*.yaml
  prompts/*.md
```

The helper prefers this harness-neutral root, then falls back to legacy `.claude/audit/`, then to the generic built-in `commit` and `pr` profiles bundled with this skill. A direct profile path or explicit `--audit-config-root` takes precedence over both repo roots.

After environment expansion, fragments from discovered neutral, legacy, or bundled profiles must remain inside their selected config root. Direct profiles and explicit config roots are the caller's opt-in to external fragments. Symbolic-link path components always fail closed. The supported YAML subset also rejects `__proto__`, `prototype`, and `constructor` mapping keys recursively, and stage recording rejects those names as reviewer keys.

Prompt/profile changes that are generally useful for a repo should go through normal review and be committed. One-off, secret, machine-specific, or experimental prompt changes belong under `.audit/local/audit-experiments/`. The helper prefers `.audit/local/audit.overrides.yaml` and falls back to `.claude/local/audit.overrides.yaml`. Audit metadata records the selected config root, profile source, override source, and artifact-root source.

Generated/private artifacts live under gitignored:

```txt
.audit/local/audits/<audit-id>/
```

Repositories with `.audit/` use the neutral artifact root by default; repositories without it retain the legacy `.claude/local/audits/` fallback. Resolution is explicit: `--artifact-root`, profile `artifact_root`, neutral default when `.audit/` exists, then legacy fallback.

The helper refuses to write artifacts inside a git repository unless the complete audit directory itself is ignored; it also checks every planned standard artifact and unpredictable focused-verification candidates as defense in depth. `--allow-unignored-artifacts` is incompatible with immutable target snapshots and is rejected because generated reports would change the target. Prefer adding `.audit/local/` to `.gitignore` or `.git/info/exclude`; retain `.claude/local/` ignores while legacy artifacts exist. It also rejects symbolic-link path components, invalid multi-component audit IDs, and any audit-ID collision instead of reusing or overwriting an existing directory. Startup revalidates the target after writing the initial metadata and prompts.

Bind every selected Git repository to `git-worktree-v2`. This records resolved refs/OIDs, review-oriented diff digests, and ordered index-plus-raw-worktree manifests for tracked and nonignored untracked paths. Read current final-component type independently of index mode/OID, supporting regular-file/symlink transitions while hashing raw bytes, executable modes, link text, and missing state. Reject parent symlinks, unsupported filesystem kinds, unmerged entries, duplicate roots, and tracked submodules; select a submodule as a separate profile repo. Require explicit base/head refs with different resolved OIDs for PR/stack audits. Put ordered compact capture inputs (including nullable roles), resolved digest/count summaries, and per-repo/aggregate digests in every fixed reviewer prompt; keep full manifests in `audit.yml`. Revalidate at every record and finalization; start a new audit after any drift. Finalization binds every fixed or supplemental prompt and report to its dispatched artifact metadata and rejects invalid or premature completion timestamps. See `PROFILE-SCHEMA.md` and `AUDIT-METADATA.md` for fields.

Do not commit `.audit/local/` or legacy `.claude/local/` artifacts unless the human explicitly requests moving distilled context into tracked docs.

## Privacy and secrets

Treat audit artifacts as local/private by default. Do not put secrets, tokens, private endpoints, raw payloads, customer data, or sensitive logs into tracked prompts, PR notes, review comments, or receipts. Receipts should summarize validation without sensitive output. If sensitive evidence is necessary for a finding, keep it in local artifacts and say that sensitive evidence was reviewed locally.

## Audit types

- Commit Audit: review a local diff unit before it becomes committed or pushed history, such as unstaged changes, staged changes, or a commit/range.
- PR Audit: review a pull request as the reviewable integration unit, including full diff against base, PR claims, affected contracts/tests/docs, and stacked-PR context when relevant.
- Multi-repo Platform Audit: review multiple repositories that are parts of the same product/platform, such as a backend repo and frontend repo for one platform. Keep this lightweight: one platform context root, named member repo roots/roles, and required first steps are enough for v1. Do not broaden an audit across unrelated platforms unless the human explicitly scopes that unusual case.

Profiles are human-editable. Tracked profiles should prefer portable relative paths and environment-variable placeholders. Machine-specific path overrides belong in gitignored `.audit/local/audit.overrides.yaml` (preferred) or `.claude/local/audit.overrides.yaml` (legacy), not tracked prompt/profile files. Resolve values in this order when possible: explicit CLI argument, neutral local override, legacy local override, environment variable, tracked profile default, current repo-relative path.

For v1, audit coverage applies to the diff entering the branch rather than to every final commit object. It is acceptable to amend, squash, or reorder commits after a local audit as long as meaningful resulting changes are re-audited before push or PR review. Before pushing or opening a PR, audit the outgoing branch or PR as a whole.

PR audits should understand stacked branches. Use the PR base branch as the default comparison base for the current review unit, not `main`, unless explicitly requested. Separate inherited parent findings, child-specific findings, and merge-order/base-update risks. Re-fetch and record observed base/head refs when reviewing remote PRs.

Both audit types use the same lifecycle:

```txt
candidate finding → two-run corroborated finding → human accepted/rejected → fix, review comment, or defer
```

## Two-agent finding verification gate

Require at least two separately recorded reviewer runs to report the target evidence before a finding enters synthesis, human review, terminal findings, a fix plan, or a GitHub review packet. Do not treat agreement with another reviewer's prose as target-evidence review.

Primary+peer corroboration satisfies this gate only when both reports contain the same target evidence. Give the peer only the fixed generated `peer-review-prompt.md`; it omits repository-controlled profile fragments as well as the primary artifact/path. Record its raw-target report before disclosing primary output. Use a separate prompt, artifact, and dispatch for later critique. Give any focused verifier a saved nonempty `verification-<name>-prompt.md`, save its report as `verification-<name>.md`, and record both with a new reviewer key and identity. Keep one-reviewer concerns outside terminal `findings.json`, for example as residual/open questions.

The final-diff reviewer is a separate required gate after primary and peer. It reviews the entire frozen target for interactions and omissions. It does not automatically count as a second source for prior findings, and any new final-diff finding still needs a second target-evidence reviewer before synthesis.

Before synthesis, compare reviewer artifacts, list every candidate with its concrete reviewer keys and report paths, launch verifier agents for one-run findings, and synthesize only findings with at least two qualifying keys.

## Validation command policy

Audit agents may run safe, targeted read-only or validation commands automatically when they materially improve confidence. Examples include `git status`, `git diff`, `gh pr view`, targeted tests, linters, typechecks, config/schema checks, and read-only migration graph inspection.

Require explicit human approval before expensive, stateful, hardware, network-mutating, or destructive commands. Examples include physical robot runs, database/service mutation, Docker compose lifecycle commands unless pre-approved by the profile/session, posting GitHub comments, committing, pushing, long Isaac/GPU runs, commands touching secrets, and external production-system operations.

## V1 cross-model validation

Use stable concrete reviewer keys (`primary`, `peer`, `final_diff`, and supplemental keys) in finding sources. Keep descriptive roles and actual model/tool names in `audit.yml`, not canonical artifact filenames.

Use semi-automated peer-review handoff in v1:

1. The orchestrator produces primary, blind-peer, and final-diff prompts with distinct generated dispatch IDs and prompt SHA-256 digests.
2. The human explicitly launches or approves the blind peer reviewer using only its raw-target prompt.
3. The human or a later helper writes the raw peer output to `peer-review.md` and records it before any primary-report disclosure. An optional later critique is a separate prompt/artifact/run.
4. The orchestrator applies the two-agent finding gate, dispatches focused verifiers for peer-only, primary-only, disputed, or final-diff-only findings, then synthesizes only findings that pass.
5. A distinct reviewer runs `final-diff-reviewer-prompt.md`; record it as `--stage final-diff` before finalization.

A natural cross-model peer reviewer is a second harness or model — for example, run the peer review with a different provider via its own CLI, or in a separate Claude Code session pinned to a different model.

## Suggested artifact set

```txt
.audit/local/audits/<audit-id>/
  audit.yml
  primary-reviewer-prompt.md
  primary-initial.md
  primary-findings.json
  peer-review-prompt.md
  peer-review.md
  peer-critique-prompt.md       # optional, generated only after peer-review.md is recorded
  peer-critique.md              # optional, separate reviewer run
  verification-*-prompt.md
  verification-*.md
  final-diff-reviewer-prompt.md
  final-diff-review.md
  synthesis.md
  final-human-reviewed.md
  findings.json
  final-plan.md
  receipt.md
```

Use Markdown for human review and JSON/YAML for later automation.

## Minimal v1 helpers

Use `scripts/start-audit.mjs` to compose a tracked profile, capture the immutable target snapshot, create the local artifact directory, write `audit.yml`, and write `primary-reviewer-prompt.md`, blind `peer-review-prompt.md`, and `final-diff-reviewer-prompt.md`.

Resolve the script path relative to this skill directory. When this skill is installed as part of a plugin, the skill directory is `${CLAUDE_PLUGIN_ROOT}/skills/audit-flow`. Example from a repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" --profile pr --target "PR #14" --base origin/main --head HEAD
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" diff
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" staged
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/start-audit.mjs" pr "PR #14" --base origin/main --head HEAD
```

If `${CLAUDE_PLUGIN_ROOT}` is not set (for example, running the skill from a checkout rather than an installed plugin), substitute the absolute path to this skill directory.

The helper prints JSON containing `auditDir`, `auditYmlPath`, primary/peer/final-diff prompt and report paths, and related artifact paths. Common positional commands map to profiles: `diff`, `staged`, and `commit` use the `commit` profile; `pr` and `stack` use the `pr` profile. Ref precedence is `repos[].base/head`, CLI `--base/--head`, top-level profile `base/head`, then `HEAD` only for non-PR/non-stack audits.

Use `scripts/record-stage.mjs` after a reviewer artifact has been written to record completion metadata in `audit.yml`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/record-stage.mjs" --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool claude-subagent --model <model> --session-id <unique-id>
```

Record a focused verifier with a distinct, previously unused reviewer key and scope:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/record-stage.mjs" --audit-yml <auditYmlPath> --stage verification --reviewer-key verifier-peer-only --prompt verification-peer-only-prompt.md --artifact verification-peer-only.md --scope "peer-only findings" --tool claude-subagent --model <model> --session-id <unique-id>
```

Relative `--prompt` and `--artifact` paths resolve inside the audit directory. Verifier prompts and reports must be nonempty, non-symlink paths named `verification-<name>-prompt.md` and `verification-<name>.md`.

Record the blind raw-target peer and the separate adversarial final-diff stage:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/record-stage.mjs" --audit-yml <auditYmlPath> --stage peer --artifact peer-review.md --tool <peer-tool> --model <model> --session-id <unique-id>
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/record-stage.mjs" --audit-yml <auditYmlPath> --stage final-diff --artifact final-diff-review.md --tool <reviewer-tool> --model <model> --session-id <unique-id>
```

Record primary, peer, then final-diff in order; record focused verification only after primary and peer. Every completed run requires nonempty tool/model/session identity, unique dispatch/session IDs, a nonempty prompt binding, and a nonempty report. Fixed stages cannot redirect prompts or reports and their report hashes must differ. The recorder writes a structural `orchestrator-attested` binding and atomically updates `audit.yml`. Verification runs accept `--dispatch-id`; otherwise one is generated.

After all three required reviewer stages, finding verification/synthesis, and human decisions, write valid nonempty `findings.json` and nonempty `receipt.md`, then finalize strictly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-flow/scripts/finalize-audit.mjs" --audit-yml <auditYmlPath> --status <passed|passed_with_deferred|blocked>
```

Finalization validates the unchanged snapshot, run identities/attestations, prompts/reports, and final artifacts. `findings.json` is an array or an object with a `findings` array. It rejects missing/unknown statuses. Every retained finding, including deferred/rejected findings, requires at least two concrete completed reviewer keys, satisfied `verification.required`, exact report paths in `verification.artifacts`, and distinct cited report hashes. Unresolved statuses require `blocked`; deferred forbids `passed`; `passed_with_deferred` requires a deferred finding. See `FINDINGS-SCHEMA.md` for the exhaustive enum.

Treat these checks as local structural orchestrator attestations. They are not cryptographic/authenticated receipts and do not prove report authorship, separate execution, reviewer blindness, target inspection, or internal cognition. Distinct identities and report hashes are mistake/copy defenses, not such proof.

## Primary reviewer automation

Do not stop after generating prompts. Launch the primary reviewer automatically:

1. Run `start-audit.mjs` for the requested profile/target.
2. Launch a fresh reviewer with the Agent tool, `subagent_type` set to `reviewer` (the read-only reviewer bundled with this plugin), passing the contents of `primary-reviewer-prompt.md` as the task. Instruct it to operate in the audited repo root and to return the full audit report as its final message.
3. The reviewer must not edit application code.
4. Save the returned report to `primary-initial.md`, then record it with nonempty `--tool`, `--model`, and unique `--session-id` values.
5. Tell the human where `primary-initial.md` and the blind `peer-review-prompt.md` were written. Do not give the peer the primary report or its path. Pause for the semi-automated raw-target peer step.

If launching a subagent is not possible, perform the primary review in the parent session, write the result to `primary-initial.md`, and record truthful parent tool/model/session identity.

## Orchestration outline

1. Read repo instructions: `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `CONTRIBUTING.md`, and `docs/adr/*.md` when present.
2. Identify audit type, selected repositories, target base/head refs, and current git cleanliness constraints.
3. Run the start helper for the selected profile and target. Confirm `audit.yml` contains the intended ordered `git-worktree-v2` repo snapshots before dispatch.
4. Launch the primary reviewer automatically and save its report to `primary-initial.md`.
5. Record primary with complete tool/model/session identity.
6. Launch the peer with only `peer-review-prompt.md`; do not disclose the audit directory. Save its raw-target output to `peer-review.md`, then record peer with complete identity. Only then may a separate critique see primary output.
7. Compare raw reviewer artifacts, identify findings with fewer than two reviewer keys, launch focused verifiers from saved `verification-*-prompt.md` prompts, save/record `verification-*.md`, and exclude one-run concerns from terminal findings.
8. Launch a distinct reviewer with `final-diff-reviewer-prompt.md`, save `final-diff-review.md`, and record `--stage final-diff`. Route any new finding through the same verification gate.
9. Synthesize disagreements and candidate findings that passed the two-agent gate.
10. Keep the parent session live for human drill-down.
11. After human confirmation, write final accepted/rejected/deferred findings and a fix or PR-review plan.
12. Produce `findings.json` and `receipt.md`, then use `finalize-audit.mjs`. Any snapshot or digest drift blocks finalization.
13. Only after finalization run a fixing agent or generate GitHub review comments. Code changes create a new target snapshot and therefore require a new audit before commit/push.
14. In the follow-up audit, run targeted verification and re-audit the whole resulting diff, marking accepted findings `fixed`, `partially_fixed`, `still_open`, or `verified` as appropriate.

## Audit receipt

A completed audit should write `receipt.md` under the audit artifact directory. Include audit type and exact target snapshot, profile/fragments used (noting that peer omits repository fragments), required reviewer dispatch/session/model provenance, peer and final-diff completion, human accepted/rejected/deferred counts, planned fixes or review comments, validation commands/results, residual risks, trust-boundary caveat, and final status.

## Review/fix separation

Reviewer sessions are read-only with respect to application code. They may create audit artifacts only under the selected neutral `.audit/local/audits/` or legacy `.claude/local/audits/` directory and run validation commands, but must not modify source, tests, docs, configs, migrations, or generated committed assets. The audited Git state is frozen through finalization. A separate fix pass may edit code only after the human accepts findings, approves the fix scope, and the current audit is finalized. For local work, offer both a generated `fix-prompt.md` and an orchestrated fix pass; default to launching a separate writer session (the Agent tool with a general-purpose subagent, or a fresh Claude Code session). The writer must fix only accepted findings, ignore rejected/deferred findings, run targeted validation, and return a summary/diff. Because that pass changes the snapshot, start a follow-up audit of the resulting full diff before committing or pushing. For coworker PRs, generate review comments from accepted findings instead of fixing unless the human explicitly asks to make changes on a branch.

## GitHub PR review comment policy

Post only human-accepted findings. Accepted confirmed findings with exact diff anchors become inline GitHub review comments. Accepted PR-level findings without stable line anchors go in the review body. Open questions are posted only when the human explicitly approves asking them. Optional suggestions are not posted by default. Rejected findings are never posted. Deferred findings usually become local follow-up issues or notes rather than PR comments unless they directly affect the reviewed PR.

In v1, prepare a GitHub review packet instead of directly posting externally visible comments. The packet may include `github-review-packet.md`, `github-review-comments.json`, and `peer-github-review-prompt.md` under the audit artifact directory. The human reviews the packet, then an approved peer agent or the human posts it with `gh`. Direct posting can be added later after comment anchoring and approval UX are proven.

## Output standards

Put findings first, ordered by severity. Confirmed findings need exact file/line references, impact, evidence, and concrete reviewer keys/artifacts containing the target-evidence review. Separate confirmed findings, open questions/assumptions, optional suggestions, and residual validation gaps. Never present a single-reviewer concern as confirmed. Report intended peer input isolation separately from later critique, and final-diff completion separately from finding-verification counts.
