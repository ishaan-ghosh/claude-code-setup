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
- **Hooks** (`hooks/`)
  - `read-policy` — nudges toward a search-first, paginated-read strategy to keep context small (Read/Grep/Glob and Bash).
  - `session-policy` — injects [`policy/session-policy.md`](policy/session-policy.md) at session start so the defaults apply in every repo, even ones with no `CLAUDE.md`/`AGENTS.md`.
  - `model-policy` — enforces subagent model routing: explicit `opus` for code and judgment, `sonnet` only for mechanical context collection, no forks.
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

`audit-flow` prefers `.audit/`, then supports `.claude/audit/` as a legacy fallback. Profile selection is direct `--profile`, explicit `--audit-config-root`, neutral repo profile, legacy repo profile, then the bundled default. Artifact selection is `--artifact-root`, profile `artifact_root`, then neutral `.audit/local/audits`, except in legacy repositories (legacy `.claude/` audit state and no `.audit/`), which keep `.claude/local/audits`. The neutral `.audit/local/audit.overrides.yaml` similarly wins over the legacy override. `audit.yml` records each selected source. After environment expansion, repository-discovered and bundled profile fragments must remain inside their config root; direct profiles and explicit config roots are the caller's opt-in to external fragments. Reserved YAML mapping keys that can alter object lookup semantics are rejected recursively.

**Works in any repo.** `/audit` needs no setup. In a repository without `.audit/`, `.claude/`, `CLAUDE.md`, or `AGENTS.md`, it uses the bundled `commit`/`pr` profiles and writes private artifacts to `.audit/local/audits/<audit-id>/`. Audit artifacts must be git-ignored so they can't change the audited snapshot. If that directory isn't ignored yet, `start-audit.mjs` appends `/.audit/local/` to the repo's local `.git/info/exclude`, which is never committed and is the correct file for worktrees and submodules. It does this before capturing the snapshot, and records the change under `artifact_exclude` in `audit.yml`. Pass `--no-auto-exclude` to leave git config untouched; the helper then stops and tells you to add `.audit/local/` to `.gitignore` or `.git/info/exclude` yourself. Explicit `--artifact-root` or profile `artifact_root` paths are never auto-excluded. Repos that already use the legacy `.claude/audit/` or `.claude/local/audits/` layout keep using `.claude/local/audits/`.

The helper requires the complete repository-local audit directory itself to be ignored; `--allow-unignored-artifacts` is rejected because generated reports would change the immutable target. It also checks every planned standard artifact plus unpredictable verification candidates before creating the directory, then revalidates the target after startup writes. It rejects symbolic-link path components, invalid multi-component audit IDs, and existing audit-ID directories rather than following, escaping, or overwriting them. Every selected Git repository is bound to a `git-worktree-v2` snapshot: resolved refs/OIDs, staged and unstaged diff digests, an ordered stage-0 index plus raw tracked-worktree manifest, and an ordered raw manifest for nonignored untracked files. Raw file bytes, executable modes, and symlink link text are re-read directly, so filters and index cache flags cannot hide drift. Parent symlinks, unmerged entries, unsupported filesystem kinds, and tracked submodules fail closed; select submodules as separate profile repositories. PR/stack audits require explicit base/head refs that resolve to different commits.

The audit procedure requires two separate reviewer runs to inspect the target evidence for each terminal finding. The peer first performs a raw-target review from a fixed generated prompt that omits repository-controlled profile fragments and does not disclose the primary artifact or its path; any later comparison is a separate critique run. Primary-only, peer-only, or disputed findings need a focused verifier recorded in `verification-*.md`. A separate adversarial `final-diff` review of the whole frozen target is also required before finalization; it does not substitute for finding verification.

Generated prompts and recorded reports carry SHA-256 digests. Every completed run requires nonempty tool/model/session identity, unique dispatch and session IDs, and an orchestrator-attested structural binding to the target, prompt, and report. Reserved YAML keys cannot be used as reviewer keys. Reviewer completion cannot predate audit creation; primary, peer, and final-diff run in timestamp order; supplemental reviewers cannot predate peer completion; and finalization cannot predate any completed reviewer. Fixed and supplemental runs cannot substitute dispatched prompt or report paths, and fixed reports cannot be byte-identical. Terminal findings must include every documented content field with valid severity, confidence, status, and recommended-action enums, use concrete reviewer keys and exact report artifacts, and satisfy the two-run verification gate for all statuses including `deferred`. `audit.yml` updates are serialized and atomically renamed.

This provenance is local caller/orchestrator-attested bookkeeping, not a cryptographic or authenticated execution receipt. It does not prove report authorship, reviewer independence or blindness, direct inspection, or internal model reasoning. The structural checks and copied-report defense help catch workflow mistakes; the orchestrator and human remain the trust boundary.

## Install

Add the marketplace and install the plugin:

```text
/plugin marketplace add ishaan-ghosh/claude-code-setup@v0.1.2
/plugin install dev-setup@claude-code-setup
```

Or from the CLI:

```bash
claude plugin marketplace add ishaan-ghosh/claude-code-setup@v0.1.2
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
    "claude-code-setup": { "source": { "source": "github", "repo": "ishaan-ghosh/claude-code-setup", "ref": "v0.1.2" } }
  },
  "enabledPlugins": { "dev-setup@claude-code-setup": true }
}
```

> **Note:** `extraKnownMarketplaces` + `enabledPlugins` register and enable the plugin, but Claude Code still requires a one-time install step for external plugins. If the plugin shows as not installed, run `claude plugin install dev-setup@claude-code-setup`.

## Policy hooks

The plugin carries its working rules itself, so they apply in every repository without a `CLAUDE.md` or `AGENTS.md`. The main session is the orchestrator; subagents follow the routing below.

**Session policy (SessionStart).** At startup, resume, `/clear` and compaction, `hooks/scripts/session-policy.mjs` adds [`policy/session-policy.md`](policy/session-policy.md) to the session context. Your own instructions come first, then the repo's instruction files, then these defaults. The injected text is capped at 8000 characters. Set `SESSION_POLICY_DISABLED=1` to turn it off.

**Model policy (PreToolUse on `Agent`/`Task`).** `hooks/scripts/model-policy.mjs` checks every subagent launch:

- `model: "opus"` is allowed. Use it for anything that writes code or makes judgments.
- `model: "sonnet"` is allowed, with a reminder that it is only for mechanical context collection and that claims you rely on need spot-checking.
- Any other model is blocked. Full model IDs count as their family, so `claude-opus-5-5` is treated as `opus`.
- A launch with no `model` is allowed only if the agent's definition pins an allowed model in its frontmatter. This covers `dev-setup:reviewer` (pinned to `opus`) and any project (`.claude/agents/`) or user (`~/.claude/agents/`) agent with `model: opus`/`sonnet`. Built-in agents (`general-purpose`, `Explore`, `Plan`, ...) need an explicit `model`, and `model: inherit` does not count as pinned. Other plugins' agents need an explicit `model`.
- `fork` subagents are blocked. They inherit the orchestrator's model and ignore `model`, so use `general-purpose` with an explicit model instead.

| Variable | Values | Default |
|---|---|---|
| `MODEL_POLICY_MODE` | `deny` (block with a reason), `warn` (allow and add a note), `ask` (ask you), `off` | `deny` |
| `MODEL_POLICY_DISABLED` | `1` turns the hook off | unset |
| `MODEL_POLICY_ALLOWED` | comma list of allowed model families, e.g. `opus,sonnet,haiku` | `opus,sonnet` |
| `SESSION_POLICY_DISABLED` | `1` stops the session policy being added | unset |

Set these in the `env` block of your settings or in your shell. Both hooks fail open: bad input or an internal error never blocks your work. The hook sees only the launch request, not the model Claude Code finally resolves.

**The orchestrator model is set in your settings, not by the plugin.** Plugins can't choose the main session's model, so set it in `~/.claude/settings.json` (as `settings.example.json` does):

```json
{ "model": "claude-fable-5-1" }
```

## read-policy hook

The hook keeps context small by discouraging unbounded full-file reads. It is a context-hygiene nudge, not a security boundary.

- Prefer `Grep`/`Glob`, or a shell search (`rg`, `grep`, `find`, `fd`, `ls`, `tree`, `git grep`, `git ls-files`), to locate what matters. A search **unlocks** unbounded reads for the rest of that turn.
- Otherwise read with a bound: `Read` with `limit` ≤ 400, or a bounded shell read such as `head -n N`, `tail -n N`, `sed -n 'A,Bp'`, `awk 'NR<=N'`, or `bat -r A:B` (N ≤ 400 lines), or pipe the read into one of those limiters.
- Bash reads (`cat`, `head`, `tail`, `sed`, `awk`, `less`, `more`, `bat`, `nl`, `tac`, `git show`, `git diff`, `git blame`) are checked through compound commands, leading `VAR=` assignments, common wrappers (`sudo`, `env`, `command`, `exec`, `time`, `nice`, `timeout`, `xargs`), `bash -c '…'`, and `$(…)`. Piping a read into a search (`cat big.txt | rg needle`) does **not** count as searching first. Output redirected to a file (`cat a > b`, heredocs) is not a read.
- An explicit request like "read the full file" or "show me the entire file" also unlocks the read.

Unlike the Pi extension (which silently capped a read's `limit`), this hook does not rewrite tool inputs, so an unbounded pre-search read is handled by mode. Set `READ_POLICY_MODE` (via the `env` block in settings or your shell):

| Mode | Behavior |
|------|----------|
| `warn` (default) | Allow, but inject a reminder to paginate. |
| `deny` | Block the read with a reason so Claude retries bounded or searches first. |
| `ask` | Surface a permission prompt to you. |
| `off` | Disable the policy (also `READ_POLICY_DISABLED=1`). |

Per-turn state is stored under `$CLAUDE_PLUGIN_DATA/read-policy/` (or a per-user directory in the system temp dir), one file per session named by a hash of the session id. The directory is `0700`, files are `0600`, and files older than 7 days are pruned. `UserPromptSubmit` resets the state each turn. The hook fails open: malformed input or any internal error lets the tool proceed.

## Update

`claude plugin update` compares the `version` in `.claude-plugin/plugin.json`, so every release bumps it.

If the marketplace was added **without** a ref (it tracks `main`), refresh the catalog and then the plugin, and restart Claude Code:

```bash
claude plugin marketplace update claude-code-setup
claude plugin update dev-setup@claude-code-setup             # user scope
claude plugin update dev-setup@claude-code-setup -s project  # run inside each project with a project-scoped install
```

If it was added **with** a ref (`@vX.Y.Z`, or `ref` in settings), that registration cannot discover newer releases. Replace it deliberately (the remove step also removes plugins installed from that marketplace) and update the `ref` in your settings:

```bash
claude plugin marketplace remove claude-code-setup
claude plugin marketplace add ishaan-ghosh/claude-code-setup@vNEW
claude plugin install dev-setup@claude-code-setup
```

### Releasing

1. Bump `version` in `.claude-plugin/plugin.json` and `package.json`, and the pinned refs in this README and `settings.example.json`.
2. Run `npm run check` and `npm run validate`.
3. After merge, create an annotated tag on `main`: `git tag -a vX.Y.Z -m "vX.Y.Z"`. The release workflow checks that the tag matches the plugin version.

## Test

```bash
npm run check      # all tests + tracked-secret scan + release consistency
npm run validate   # claude plugin validate . (needs the claude CLI)
```

`npm run check` runs the audit-flow, hook (read, model, and session policy), and check-script tests (`node --test`, Node 22+), then `scripts/check-secrets.mjs` (scans the Git index for credential files, private keys, credential URLs, Anthropic keys, and GitHub tokens) and `scripts/check-release.mjs` (version agreement across manifests/docs/settings, skill/agent/command frontmatter, `${CLAUDE_PLUGIN_ROOT}` paths, and relative links). CI runs the same on Ubuntu and macOS.

## Secrets policy

Do not commit:

- `~/.claude/.credentials.json` or any auth tokens
- sessions or transcripts
- `.audit/local/` audit artifacts (gitignored)
- legacy `.claude/local/` audit artifacts (gitignored)
- literal API keys in `settings.json`

Use `/login`, environment variables, or a secret manager instead.
