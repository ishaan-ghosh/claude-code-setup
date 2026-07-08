# Audit metadata v1

`audit.yml` is the canonical place to record audit target metadata, profile composition, actual tools/models, and session provenance. Findings should use generic source roles such as `primary-reviewer`, `peer-reviewer`, and `human-drilldown`; concrete tool/model names belong here.

Example:

```yaml
id: 2026-05-07-pr-14-smolvla
type: pr
status: in_progress # in_progress | passed | passed_with_deferred | blocked
created_at: 2026-05-07T12:00:00Z
updated_at: 2026-05-07T12:30:00Z

target:
  platform: RoboCortex
  repo: deployment-harness
  pr: 14
  base: docs/http-json-shadow-vla-vps-smoke
  head: feat/smolvla-shadow-adapter
  base_ref: abc123
  head_ref: def456

profile:
  name: pr
  path: .claude/audit/profiles/pr.yaml
  fragments:
    - prompts/base.md
    - prompts/repo-context.md
    - prompts/pr-github-worktree.md
    - prompts/validation-policy.md
    - prompts/output-format.md
  local_overrides:
    - .claude/local/audit.overrides.yaml

reviewers:
  primary:
    role: primary-reviewer
    tool: pi
    model: openai/example
    session_id: pi-session-id
    prompt: primary-reviewer-prompt.md
    artifact: primary-initial.md
    completed_at: 2026-05-07T12:10:00Z
  peer:
    role: peer-reviewer
    tool: external-peer-agent
    model: example-model
    session_id: optional-session-id
    prompt: peer-review-prompt.md
    artifact: peer-review.md
    completed_at: null

validation:
  - command: uv run pytest -q
    result: passed
    summary: 39 passed

artifacts:
  root: .claude/local/audits/2026-05-07-pr-14-smolvla
  primary_prompt: primary-reviewer-prompt.md
  primary_initial: primary-initial.md
  peer_review_prompt: peer-review-prompt.md
  peer_review: peer-review.md
  findings: findings.json
  receipt: receipt.md
```

Keep this file local/private by default under `.claude/local/audits/<audit-id>/`.
