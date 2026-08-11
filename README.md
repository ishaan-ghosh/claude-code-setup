# claude-code-setup

Shared Claude Code setup for my machines and coworkers. This is the Claude Code counterpart to [`pi-dev-setup`](https://github.com/ishaan-ghosh/pi-dev-setup).

The repo is a **Claude Code plugin marketplace**: it is a single GitHub repo that is both the marketplace catalog (`.claude-plugin/marketplace.json`) and one plugin, `dev-setup` (`.claude-plugin/plugin.json`), installable with `/plugin`.

## What's inside

The `dev-setup` plugin bundles:

- **Skills** (`skills/`)
  - `tdd` — red-green-refactor test-driven development.
  - `diagnose` — disciplined diagnosis loop for hard bugs and performance regressions.
  - `grill-with-docs` — interrogate a design/ADR against the docs.
  - `improve-codebase-architecture` — deepen modules and interfaces.
  - `to-prd` — turn the current context into a PRD and publish it to the issue tracker.
  - `audit-flow` — human-in-the-loop commit/PR/platform audit workflow with repo-local prompt profiles, an automated primary-reviewer handoff, cross-model peer review artifacts, and local artifact receipts.
- **Command** (`commands/`)
  - `/audit` — start the audit flow (`/audit <commit|diff|staged|pr|stack> [target]`).
- **Agent** (`agents/`)
  - `reviewer` — a read-only auditor subagent used by `audit-flow` (and usable on its own).
- **Hook** (`hooks/`)
  - `read-policy` — nudges toward a search-first, paginated-read strategy to keep context small.
- **`settings.example.json`** — a non-secret user-settings template (model, theme, marketplace registration, plugin enablement, read-policy tuning, a small permissions allowlist).

The engineering skills are vendored and adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills); see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Audit workspace layout

For repository-specific audit configuration, use the harness-neutral tracked root:

```text
.audit/
  profiles/
  prompts/
  local/       # private artifacts and machine-local overrides; keep ignored
```

`audit-flow` prefers `.audit/`, then supports `.claude/audit/` as a legacy fallback. Profile selection is direct `--profile`, explicit `--audit-config-root`, neutral repo profile, legacy repo profile, then the bundled default. Artifact selection is `--artifact-root`, profile `artifact_root`, then neutral `.audit/local/audits` when the repository has `.audit/`, otherwise legacy `.claude/local/audits`. The neutral `.audit/local/audit.overrides.yaml` similarly wins over the legacy override. `audit.yml` records each selected source. After environment expansion, repository-discovered and bundled profile fragments must remain inside their config root; direct profiles and explicit config roots are the caller's opt-in to external fragments. Reserved YAML mapping keys that can alter object lookup semantics are rejected recursively.

The helper requires the complete repository-local audit directory itself to be ignored; `--allow-unignored-artifacts` is rejected because generated reports would change the immutable target. It also checks every planned standard artifact plus unpredictable verification candidates before creating the directory, then revalidates the target after startup writes. It rejects symbolic-link path components, invalid multi-component audit IDs, and existing audit-ID directories rather than following, escaping, or overwriting them. Every selected Git repository is bound to a `git-worktree-v2` snapshot: resolved refs/OIDs, staged and unstaged diff digests, an ordered stage-0 index plus raw tracked-worktree manifest, and an ordered raw manifest for nonignored untracked files. Raw file bytes, executable modes, and symlink link text are re-read directly, so filters and index cache flags cannot hide drift. Parent symlinks, unmerged entries, unsupported filesystem kinds, and tracked submodules fail closed; select submodules as separate profile repositories. PR/stack audits require explicit base/head refs that resolve to different commits.

The audit procedure requires two separate reviewer runs to inspect the target evidence for each terminal finding. The peer first performs a raw-target review from a fixed generated prompt that omits repository-controlled profile fragments and does not disclose the primary artifact or its path; any later comparison is a separate critique run. Primary-only, peer-only, or disputed findings need a focused verifier recorded in `verification-*.md`. A separate adversarial `final-diff` review of the whole frozen target is also required before finalization; it does not substitute for finding verification.

Generated prompts and recorded reports carry SHA-256 digests. Every completed run requires nonempty tool/model/session identity, unique dispatch and session IDs, and an orchestrator-attested structural binding to the target, prompt, and report. Reserved YAML keys cannot be used as reviewer keys. Primary, peer, and final-diff run in timestamp order; supplemental reviewers cannot predate peer completion. Fixed and supplemental runs cannot substitute dispatched prompt or report paths, and fixed reports cannot be byte-identical. Terminal findings use concrete reviewer keys and exact report artifacts; all documented statuses, including `deferred`, require at least two cited runs. `audit.yml` updates are serialized and atomically renamed.

This provenance is local caller/orchestrator-attested bookkeeping, not a cryptographic or authenticated execution receipt. It does not prove report authorship, reviewer independence or blindness, direct inspection, or internal model reasoning. The structural checks and copied-report defense help catch workflow mistakes; the orchestrator and human remain the trust boundary.

## Install

Add the marketplace and install the plugin:

```text
/plugin marketplace add ishaan-ghosh/claude-code-setup@v0.1.1
/plugin install dev-setup@claude-code-setup
```

Or from the CLI:

```bash
claude plugin marketplace add ishaan-ghosh/claude-code-setup@v0.1.1
claude plugin install dev-setup@claude-code-setup
```

## Optional settings sync

`settings.example.json` is a reference for your **user-level** `~/.claude/settings.json`. A plugin cannot set your `model`, `theme`, or `permissions` — those live in your own settings — so copy the parts you want:

```bash
# Review it first, then merge the keys you want into ~/.claude/settings.json
cat settings.example.json
```

It registers the marketplace and enables the plugin declaratively:

```json
{
  "extraKnownMarketplaces": {
    "claude-code-setup": { "source": { "source": "github", "repo": "ishaan-ghosh/claude-code-setup", "ref": "v0.1.1" } }
  },
  "enabledPlugins": { "dev-setup@claude-code-setup": true }
}
```

> **Note:** `extraKnownMarketplaces` + `enabledPlugins` register and enable the plugin, but Claude Code still requires a one-time install step for external plugins. If the plugin shows as not installed, run `claude plugin install dev-setup@claude-code-setup`.

## read-policy hook

The hook keeps context small by discouraging unbounded full-file reads:

- Prefer `Grep`/`Glob` to locate what matters. A search **unlocks** unbounded reads for the rest of that turn.
- Otherwise read with a bounded `offset`/`limit` (≤ 400 lines).
- An explicit request like "read the full file" also unlocks the read.

Unlike the Pi extension (which silently capped a read's `limit`), a Claude Code hook can't rewrite tool inputs, so an unbounded pre-search read is handled by mode. Set `READ_POLICY_MODE` (via the `env` block in settings or your shell):

| Mode | Behavior |
|------|----------|
| `warn` (default) | Allow, but inject a reminder to paginate. |
| `deny` | Block the read with a reason so Claude retries bounded or searches first. |
| `ask` | Surface a permission prompt to you. |
| `off` | Disable the policy (also `READ_POLICY_DISABLED=1`). |

Per-turn state is stored under `$CLAUDE_PLUGIN_DATA` (or the system temp dir), keyed by session id. The hook fails open: any internal error lets the tool proceed.

## Update

After pushing changes, bump `version` in `.claude-plugin/plugin.json` and create
the matching reviewed tag. Then deliberately replace the pinned marketplace
registration and update the installed plugin:

```bash
claude plugin marketplace remove claude-code-setup
claude plugin marketplace add ishaan-ghosh/claude-code-setup@vNEW
claude plugin install dev-setup@claude-code-setup
```

The remove step also removes plugins installed from that marketplace, so
approve it deliberately. Also update the `ref` in your settings. The plugin
pins an explicit `version`, so a marketplace that remains registered at an
older ref cannot discover the new release.

## Test

```bash
npm test              # audit-flow script tests (node --test)
claude plugin validate .   # validate marketplace.json + plugin.json
```

## Secrets policy

Do not commit:

- `~/.claude/.credentials.json` or any auth tokens
- sessions or transcripts
- `.audit/local/` audit artifacts (gitignored)
- legacy `.claude/local/` audit artifacts (gitignored)
- literal API keys in `settings.json`

Use `/login`, environment variables, or a secret manager instead.
