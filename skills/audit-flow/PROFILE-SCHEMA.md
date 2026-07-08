# Audit profile schema v1

Audit profiles are human-editable YAML files. The v1 workflow treats this schema as a documented convention, not a strict validation contract. Keep profiles portable and reviewable. Repo-local profiles override generic built-in `commit` and `pr` defaults bundled with the audit-flow skill.

```yaml
name: pr
description: Full PR audit
type: pr # pr | commit | platform

# Prompt fragments are resolved relative to the repo's `.claude/audit/` directory
# unless an absolute path is supplied.
fragments:
  - prompts/base.md
  - prompts/repo-context.md
  - prompts/output-format.md

# Optional. Use for multi-repo audits where all repos are part of one product/platform.
platform:
  name: RoboEval
  context_root: ${ROBOEVAL_ROOT:-..}
  source_of_truth:
    - AGENTS.md
    - merge_context.md

# Optional for single-repo audits, expected for platform audits. Paths should be
# relative to `platform.context_root` when possible.
repos:
  - name: backend
    role: api-worker-sandbox
    path: backend
  - name: frontend
    role: web-ui
    path: RoboEval-frontend

# Optional. Defaults to `.claude/local/audits` in the current or primary repo.
artifact_root:
  repo: backend
  path: .claude/local/audits

# Optional suggested validation commands. Auditors should run targeted validation
# when useful and state what was or was not verified.
validation:
  commands:
    - name: tests
      command: uv run pytest -q
```

## Path resolution

Tracked profiles should prefer relative paths and environment-variable placeholders. Machine-specific overrides belong in gitignored `.claude/local/audit.overrides.yaml`.

Recommended resolution order:

1. Explicit audit argument
2. `.claude/local/audit.overrides.yaml`
3. Environment variable
4. Tracked profile default
5. Current repo-relative path

## Notes

- Do not use platform profiles to casually span unrelated platforms. Multi-repo platform audits are for repositories that make up one product/platform.
- Avoid copying full historical prompts into profiles. Prefer small reusable prompt fragments.
- Future extensions may validate this schema after the workflow stabilizes.
