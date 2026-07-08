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

## Install

Add the marketplace and install the plugin:

```text
/plugin marketplace add ishaan-ghosh/claude-code-setup
/plugin install dev-setup@claude-code-setup
```

Or from the CLI:

```bash
claude plugin marketplace add ishaan-ghosh/claude-code-setup
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
    "claude-code-setup": { "source": { "source": "github", "repo": "ishaan-ghosh/claude-code-setup" } }
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

After pushing changes, bump `version` in `.claude-plugin/plugin.json`, then:

```bash
claude plugin marketplace update claude-code-setup
claude plugin update dev-setup@claude-code-setup
```

(The plugin pins an explicit `version`, so updates land when the version is bumped. Omit `version` from `plugin.json` if you'd rather track every commit.)

## Test

```bash
npm test              # audit-flow script tests (node --test)
claude plugin validate .   # validate marketplace.json + plugin.json
```

## Secrets policy

Do not commit:

- `~/.claude/.credentials.json` or any auth tokens
- sessions or transcripts
- `.claude/local/` audit artifacts (gitignored)
- literal API keys in `settings.json`

Use `/login`, environment variables, or a secret manager instead.
