# Audit metadata v1

`audit.yml` is the canonical place to record audit target metadata, profile composition, concrete reviewer keys, actual tools/models, session identities, and structural orchestrator attestations. `findings.json.source` cites keys from `reviewers` such as `primary`, `peer`, or `verifier_peer_only`; roles remain descriptive metadata.

Example:

```yaml
id: 2026-05-07-pr-14-smolvla
type: pr
status: in_progress # in_progress | passed | passed_with_deferred | blocked
created_at: 2026-05-07T12:00:00Z
updated_at: 2026-05-07T12:30:00Z

target:
  platform: RoboCortex
  raw: PR 14
  snapshot_schema: git-worktree-v2
  snapshot_sha256: 7c0b...f21a
  repos:
    - name: deployment-harness
      role: deployment
      root: /workspace/RoboCortex/deployment-harness
      base_ref: origin/main
      base_oid: abc123...7890
      head_ref: HEAD
      head_oid: def456...0123
      staged_diff_sha256: 43a1...0a11
      unstaged_diff_sha256: 8b20...72ce
      tracked_manifest_sha256: a102...cc82
      tracked:
        - path: scripts/check.sh
          index_mode: "100755"
          index_oid: 932a...9ca1
          worktree_mode: "100755"
          sha256: 110f...cc20
        - path: docs/omitted-in-sparse-checkout.md
          index_mode: "100644"
          index_oid: b521...a1f2
          worktree_mode: missing
          sha256: null
      untracked_manifest_sha256: d992...139f
      untracked:
        - path: scripts/new-check.sh
          mode: "100755"
          sha256: 110f...cc20
      snapshot_sha256: a6d4...8b91

profile:
  name: pr
  path: .audit/profiles/pr.yaml
  source: repo-neutral
  config_root: .audit
  fragments:
    - prompts/base.md
    - prompts/repo-context.md
    - prompts/pr-github-worktree.md
    - prompts/validation-policy.md
    - prompts/output-format.md
  local_overrides:
    - .audit/local/audit.overrides.yaml
  local_override_source: neutral

reviewers:
  primary:
    role: primary-reviewer
    dispatch_id: 98fef8c5-a2c0-48f7-9130-054ca94f8291
    tool: pi
    model: openai/example
    session_id: pi-session-id
    prompt: primary-reviewer-prompt.md
    prompt_sha256: 34aa...f8d0
    prompt_fragments:
      - prompts/base.md
      - prompts/output-format.md
    artifact: primary-initial.md
    report_sha256: 894c...0a9d
    completed_at: 2026-05-07T12:10:00Z
    attestation:
      kind: orchestrator-attested
      audit_id: 2026-05-07-pr-14-smolvla
      reviewer_key: primary
      dispatch_id: 98fef8c5-a2c0-48f7-9130-054ca94f8291
      target_snapshot_sha256: 7c0b...f21a
      prompt_sha256: 34aa...f8d0
      artifact: primary-initial.md
      report_sha256: 894c...0a9d
      recorded_at: 2026-05-07T12:10:00Z
  peer:
    role: peer-reviewer
    dispatch_id: be245744-f584-4b27-9755-afb047f92322
    tool: external-peer-agent
    model: example-model
    session_id: peer-session-id
    prompt: peer-review-prompt.md
    prompt_sha256: f34c...d00a
    prompt_fragments: []
    artifact: peer-review.md
    report_sha256: b330...fe16
    completed_at: 2026-05-07T12:20:00Z
  final_diff:
    role: final-diff-reviewer
    dispatch_id: 09006269-62e4-41dd-8814-6f0ad9f1ceca
    tool: claude-subagent
    model: example-model
    session_id: final-diff-session-id
    prompt: final-diff-reviewer-prompt.md
    prompt_sha256: 92de...24b0
    artifact: final-diff-review.md
    report_sha256: a977...7798
    completed_at: 2026-05-07T12:30:00Z
  verifier_peer_only:
    role: finding-verifier
    dispatch_id: 4a27acec-7961-44aa-82e9-8335d7bd95ca
    tool: claude-subagent
    model: example-model
    session_id: verifier-session-id
    prompt: verification-peer-only-prompt.md
    prompt_sha256: 37a0...2c81
    artifact: verification-peer-only.md
    report_sha256: c47a...278f
    scope: peer-only findings
    completed_at: 2026-05-07T12:25:00Z

validation:
  - command: uv run pytest -q
    result: passed
    summary: 39 passed

artifacts:
  root: .audit/local/audits/2026-05-07-pr-14-smolvla
  root_source: neutral-default
  primary_prompt: primary-reviewer-prompt.md
  primary_initial: primary-initial.md
  peer_review_prompt: peer-review-prompt.md
  peer_review: peer-review.md
  final_diff_prompt: final-diff-reviewer-prompt.md
  final_diff_review: final-diff-review.md
  verifier_peer_only: verification-peer-only.md
  verifier_peer_only_prompt: verification-peer-only-prompt.md
  findings: findings.json
  receipt: receipt.md

finalization:
  status: passed
  target_snapshot_sha256: 7c0b...f21a
  findings_sha256: 1c8d...23f9
  receipt_sha256: 99bb...4e02
  required_stages:
    - primary
    - peer
    - final_diff
  completed_at: 2026-05-07T13:00:00Z
```

Keep this file local/private by default under `.audit/local/audits/<audit-id>/`. Legacy-only repositories may use `.claude/local/audits/<audit-id>/` while migrating.

The profile `source` is one of `direct`, `explicit-config-root`, `repo-neutral`, `repo-legacy`, or `default`. `local_override_source` is `neutral`, `legacy`, or `null`. Artifact `root_source` records `cli`, `profile`, `neutral-default`, or `legacy-fallback`. These provenance fields make path selection auditable without exposing override contents.

All helper-parsed YAML, including profiles, overrides, and `audit.yml`, rejects the reserved mapping keys `__proto__`, `prototype`, and `constructor` recursively; stage recording rejects the same names as reviewer keys before writing metadata. Startup requires the complete audit directory itself to be ignored, validates every planned standard artifact and unpredictable focused-verification candidates as defense in depth, and revalidates the target after writing the initial metadata and prompts.

`target.repos` is ordered exactly as the selected profile's `repos`; a single-repo audit contains one entry for the project root. `base_ref` and `head_ref` preserve the input strings while the OIDs pin resolved commits. PR/stack refs are mandatory and must resolve to different commits. The staged and unstaged hashes retain Git's review-oriented binary diff identity. The ordered `tracked` manifest separately binds each stage-0 index mode/OID and the raw worktree state, so clean/smudge filters, `assume-unchanged`, and `skip-worktree` cannot hide byte drift. Current `lstat` type determines `worktree_mode` independently of index mode/OID, so supported regular-file-to-symlink and symlink-to-regular transitions are captured using raw bytes or link text. Executable mode and explicit missing state are recorded. Parent symlinks, unsupported filesystem kinds, unmerged stages, and tracked gitlinks fail closed; audit a submodule as a separate selected repository. The ordered untracked manifest uses the same raw file/symlink treatment. Per-repo and aggregate hashes use recursively key-sorted, whitespace-free canonical JSON and exclude the derived per-repo `snapshot_sha256` field from identity.

Every generated primary, blind-peer, and final-diff prompt includes the ordered compact capture profile (`name`, nullable `role`, canonical `path`, `base_ref`, and `head_ref`) plus resolved OIDs, component digests/counts, per-repo digests, schema, and aggregate digest. A reviewer can replay those machine-readable records against the bound raw repositories to reproduce the displayed identities. Full tracked/untracked arrays remain in `audit.yml` rather than the prompt; omitting them keeps large-repository prompts bounded and does not disclose review artifacts to the blind peer.

Every completed reviewer run requires nonempty `tool`, `model`, and audit-unique `session_id`; every run also has a unique `dispatch_id`. Fixed and supplemental reviewer prompt and report paths are bound to their dispatched `audit.artifacts` entries, and reports are nonempty and hashed when recorded. Primary, peer, and final-diff stages cannot be redirected or overwritten, must run in timestamp order, and must have pairwise-distinct report hashes. Supplemental reviewers require valid completion timestamps no earlier than peer completion. The blind peer prompt contains no primary artifact or path and intentionally receives no repository-controlled profile fragments; an optional later critique must have a separate prompt, artifact, and dispatch ID.

`attestation.kind: orchestrator-attested` is written by `record-stage.mjs` and binds the audit, concrete reviewer key, dispatch, target snapshot, prompt digest, artifact, report digest, and record time. Every completed run has this structure even though the abbreviated example expands only the primary block. Supplemental verification runs must supply a nonempty confined `verification-<name>-prompt.md`; prompt-less reports cannot become finding sources.

After a focused verifier writes its report, record it with a unique, previously unused reviewer key:

```bash
node record-stage.mjs \
  --audit-yml .audit/local/audits/<audit-id>/audit.yml \
  --stage verification \
  --reviewer-key verifier-peer-only \
  --prompt verification-peer-only-prompt.md \
  --artifact verification-peer-only.md \
  --scope "peer-only findings" \
  --tool claude-subagent \
  --model claude-example \
  --session-id verifier-session-id
```

Each terminal finding names at least two concrete completed reviewer keys and the exact recorded artifacts that contain its target-evidence review. Keep single-reviewer concerns outside terminal `findings.json`, for example in receipt open questions.

`record-stage.mjs` revalidates the target snapshot and fixed prompt digest, enforces stage order, nonempty run identity, distinct dispatch/session provenance, the dispatched fixed-stage artifact path, and nonempty distinct fixed-stage reports, then serializes an atomic `audit.yml` update. `finalize-audit.mjs --status <passed|passed_with_deferred|blocked>` revalidates all of these bindings plus valid `findings.json` and nonempty `receipt.md`. It validates the exhaustive finding status enum and concrete reviewer/artifact bindings for every retained finding. Unresolved findings require `blocked`; deferred findings forbid `passed`; `passed_with_deferred` requires a deferred finding. Finalization refuses an existing `finalization` block rather than overwriting it.

## Trust boundary

These are local structural checks over orchestrator-written metadata and artifact bytes. They are not signed or authenticated receipts and do not cryptographically prove authorship, execution-provider identity, reviewer independence, peer blindness, target inspection, or a model's internal cognition. Nonempty identities, distinct sessions, and unequal report hashes make mistakes and naive copying harder; the orchestrator and human remain responsible for launching the declared runs and limiting their inputs.
