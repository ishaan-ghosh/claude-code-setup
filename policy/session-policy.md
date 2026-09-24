# dev-setup session policy

These defaults come from the `dev-setup` plugin and apply in every repository, including ones with no CLAUDE.md or AGENTS.md. Precedence: the user's explicit instructions, then the repository's own instruction files, then these defaults. Repository files may tighten these rules; only the user may relax them.

## Subagent models

- The main session is the orchestrator and runs on the user's configured model (Fable 5.1 via `model` in user settings); the plugin cannot set it. Everything below applies to subagents only.
- Launch every subagent with an explicit `model`. An omitted model inherits the parent session's model, which is not the rule.
- Use `model: "opus"` (Opus 5.5) for every subagent that writes code or makes judgments: implementation, planning, the primary reviewer, the blind peer, verifiers, and the final-diff review.
- Use `model: "sonnet"` (Sonnet 5) only for mechanical context collection: repo sweeps, file gathering, exemplar reads, fact lookups. Spot-check every claim from those runs that a decision depends on before relying on it.
- Do not use other models for subagents unless the user asks.
- Agents whose definition pins `opus` or `sonnet` in frontmatter (for example `dev-setup:reviewer`, or a project/user agent) may omit `model`; built-in agents (`general-purpose`, `Explore`, `Plan`, ...) never pin one.
- Do not use `fork` subagents: they always run on the orchestrator's model and ignore `model`. Launch a `general-purpose` subagent with an explicit model and a self-contained prompt instead.
- A PreToolUse hook on `Agent` enforces this. `MODEL_POLICY_MODE` is `deny` (default), `warn`, `ask`, or `off`; only the user changes it or `MODEL_POLICY_ALLOWED`. If a launch is denied, relaunch as the reason says; do not work around the hook.

## Workflows in unprepared repositories

- The plugin's skills (`audit-flow`, `tdd`, `diagnose`, `grill-with-docs`, `improve-codebase-architecture`, `to-prd`) and the `/audit` command need no repository setup. When the repo has no instruction files, follow these defaults and the skill's own instructions, and infer build/test commands from the repo's manifests instead of assuming them.
- Keep agent state out of the tracked tree: audit artifacts go under `.audit/local/` (the audit helper adds it to `.git/info/exclude` when needed); never create tracked files just to configure the harness unless the user asks.
