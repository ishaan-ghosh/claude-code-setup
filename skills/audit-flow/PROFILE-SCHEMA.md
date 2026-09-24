# Audit profile schema v1

Audit profiles are human-editable YAML files. The v1 workflow treats this schema as a documented convention, not a strict validation contract. Keep profiles portable and reviewable. Repo-local profiles override generic built-in `commit` and `pr` defaults bundled with the audit-flow skill.

```yaml
name: pr
description: Full PR audit
type: pr # pr | commit | platform

# Git commit refs for every selected repo. PR/stack profiles require both refs;
# they must resolve to different commits. Other audit types default to HEAD.
# CLI --base/--head wins over these defaults; a repo entry may override them.
base: origin/main
head: HEAD

# Prompt fragments are resolved relative to the selected config root. The
# preferred repo root is `.audit/`; `.claude/audit/` is a legacy fallback.
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
    base: origin/main
    head: HEAD
  - name: frontend
    role: web-ui
    path: RoboEval-frontend

# Optional. Defaults to `.audit/local/audits`; only legacy repositories (legacy
# `.claude/audit/` or `.claude/local/` audit state and no `.audit/`) fall back
# to `.claude/local/audits`. An explicit artifact_root.path is never auto-excluded.
artifact_root:
  repo: backend
  path: .audit/local/audits

# Optional suggested validation commands. Auditors should run targeted validation
# when useful and state what was or was not verified.
validation:
  commands:
    - name: tests
      command: uv run pytest -q
```

## Path resolution

Tracked profiles should prefer relative paths and environment-variable placeholders. Machine-specific overrides belong in gitignored `.audit/local/audit.overrides.yaml`. The legacy `.claude/local/audit.overrides.yaml` remains a fallback.

After environment expansion, fragments selected through repository-neutral, repository-legacy, or bundled-default profile discovery must remain canonically inside the selected audit config root. Absolute paths, parent traversal, and symbolic-link escapes fail closed. A direct `--profile` path or explicit `--audit-config-root` is a caller opt-in to external fragment paths; symbolic-link path components are still rejected.

Profile resolution order:

1. Direct `--profile <path>`
2. Explicit `--audit-config-root <path>`
3. `.audit/profiles/<name>.yaml`
4. `.claude/audit/profiles/<name>.yaml`
5. Built-in `commit` or `pr` profile

Value resolution order:

1. Explicit CLI argument
2. `.audit/local/audit.overrides.yaml`
3. `.claude/local/audit.overrides.yaml`
4. Environment variable
5. Tracked profile default
6. Current repo-relative path

Artifact-root resolution order:

1. `--artifact-root <path>`
2. Profile `artifact_root`
3. `.audit/local/audits` when the repository has `.audit/` (`neutral-default`)
4. `.claude/local/audits` for legacy repositories: no `.audit/`, but legacy `.claude/audit/`, existing `.claude/local/audits/`, or `.claude/local/audit.overrides.yaml` (`legacy-fallback`)
5. Otherwise `.audit/local/audits` (`neutral-bare-default`), so a repository with no audit setup at all works out of the box

The `.audit/` and legacy-config checks use the project root; the legacy-artifact check uses the artifact base (`artifact_root.repo` when set).

Target-ref resolution is per repository:

1. `repos[].base` / `repos[].head`
2. CLI `--base` / `--head`
3. Top-level profile `base` / `head`
4. `HEAD` for non-PR/non-stack audits only

## Notes

- Do not use platform profiles to casually span unrelated platforms. Multi-repo platform audits are for repositories that make up one product/platform.
- `audit.yml` records the selected profile/config, override, and artifact-root provenance without including override contents.
- A profile with `repos` selects those repositories in listed order, resolving relative paths from `platform.context_root`. Without `repos`, the current project root is the single target. Every selected path must resolve to a Git repository with committed base/head refs, and duplicate canonical roots are rejected.
- PR/stack audits fail closed unless every selected repository has explicit base and head refs whose resolved commit OIDs differ. Named refs are retained for display; the resolved OIDs bind the snapshot.
- The start helper records a `git-worktree-v2` snapshot for each repository: refs/OIDs and staged/unstaged diff digests, an ordered index-plus-raw-worktree manifest for every tracked path, and an ordered raw manifest for nonignored untracked paths. It branches on the current final-component `lstat` type while retaining the separate index mode/OID, so regular-file/symlink worktree transitions are supported and hashed as raw bytes/link text. Executable and missing states remain explicit. Parent symlink components and unsupported filesystem kinds fail closed.
- All three fixed reviewer prompts disclose the ordered machine-readable capture inputs, including nullable `role`, plus resolved component/count, per-repo, and aggregate digests. They omit the full manifests; replay uses the disclosed profile and raw repositories.
- Tracked gitlinks (`160000`) are not traversed. Select each submodule as a separate `repos[]` entry if it belongs in the audit target. Unmerged index stages also fail closed.
- When rules 3 or 5 select the artifact root and it is inside a Git repository but not ignored, the helper appends an anchored `/<project-subpath>/.audit/local/` rule to that repository's local exclude file (`git rev-parse --git-path info/exclude`) before capturing the snapshot. The edit is idempotent, never applies to `--artifact-root` or profile `artifact_root.path`, affects only the repository containing the artifact directory, and refuses symbolic-link exclude paths. `--no-auto-exclude` disables it.
- Artifact paths must be ignored. `--allow-unignored-artifacts` is rejected because generated artifacts would invalidate the target snapshot. The complete audit directory itself must be ignored so later verifier artifacts cannot escape selective file rules. Before creating it, the helper also checks every planned standard artifact plus unpredictable focused-verification candidates, then revalidates the target after writing startup artifacts. It rejects symbolic-link path components, invalid multi-component audit IDs, and existing audit-ID directories.
- The supported YAML subset rejects the reserved mapping keys `__proto__`, `prototype`, and `constructor` at every nesting level. `record-stage.mjs` also rejects them as reviewer keys before writing metadata.
- Avoid copying full historical prompts into profiles. Prefer small reusable prompt fragments.
- Future extensions may validate this schema after the workflow stabilizes.
