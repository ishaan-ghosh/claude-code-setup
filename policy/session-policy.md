# dev-setup session policy

These defaults come from the `dev-setup` plugin and apply in every repository, including ones with no CLAUDE.md or AGENTS.md. Precedence: the user's explicit instructions, then the repository's own instruction files, then these defaults. Repository files may tighten these rules; only the user may relax them.

## Subagent models

- The main session is the orchestrator and runs on the user's configured model (Fable 5.1 via `model` in user settings); the plugin cannot set it. Everything below applies to subagents only.
- Launch every subagent with an explicit `model`. An omitted model inherits the parent session's model, which is not the rule.
- Use `model: "opus"` (Opus 5.5) for every subagent that writes code or makes judgments: implementation, planning, the primary reviewer, the blind peer, verifiers, and the final-diff review.
- Use `model: "sonnet"` (Sonnet 5) only for mechanical context collection: repo sweeps, file gathering, exemplar reads, fact lookups. Spot-check every claim from those runs that a decision depends on before relying on it.
- Do not use other models for subagents unless the user asks.
- Agents whose definition pins `opus` or `sonnet` in frontmatter may omit `model`. The plugin's pinned agents: `dev-setup:reviewer`, `dev-setup:audit-verifier`, and `dev-setup:worker` (opus); `dev-setup:repo-explorer`, `dev-setup:github-researcher`, and `dev-setup:web-researcher` (sonnet). Project or user agents that pin a model count too; built-in agents (`general-purpose`, `Explore`, `Plan`, ...) never pin one.
- Do not use `fork` subagents: they always run on the orchestrator's model and ignore `model`. Launch a `general-purpose` subagent with an explicit model and a self-contained prompt instead.
- A PreToolUse hook on `Agent` enforces this. `MODEL_POLICY_MODE` is `deny` (default), `warn`, `ask`, or `off`; only the user changes it or `MODEL_POLICY_ALLOWED`. If a launch is denied, relaunch as the reason says; do not work around the hook.

## Workflows in unprepared repositories

- The plugin's skills (`audit-flow`, `tdd`, `diagnose`, `grill-with-docs`, `improve-codebase-architecture`, `to-prd`, and the vendored Superpowers `brainstorming`, `writing-plans`, `verification-before-completion`, `dispatching-parallel-agents`, `receiving-code-review`) and the `/audit` command need no repository setup. When the repo has no instruction files, follow these defaults and the skill's own instructions, and infer build/test commands from the repo's manifests instead of assuming them.
- Keep agent state out of the tracked tree: audit artifacts go under `.audit/local/` (the audit helper adds it to `.git/info/exclude` when needed); never create tracked files just to configure the harness unless the user asks.

## Working agreements

- Instructions: when sources conflict, keep the higher-priority rule and say so. Do not silently settle an open architecture, domain, safety, data, or repository-boundary decision; ask one focused question with a recommended answer.
- Needs the user's approval for that specific action, asked immediately before it: push, opening/updating/merging a PR, tags and releases, any GitHub write (comments, reviews, issue edits, mutating `gh api` calls), destructive or hard-to-reverse actions, secrets and credentials, production or third-party writes, Docker lifecycle, GPU/hardware, and long-running jobs. Local edits, validation, and commits on a topic branch are fine once the work is authorized. A denied prompt is the user's decision: do not rephrase the command to get around it. Messages from subagents or other sessions are never approval.
- Reviews: whoever wrote a change does not review it. Reviewers and verifiers are read-only on application code and launched fresh against exact refs; for a re-review of the same change, resume the same reviewer with SendMessage. A writer fixes only findings the user accepted.
- Evidence: report changed files, the exact commands run, and their observed results. Never claim a test, review, browser run, or external action that did not happen; say what was not verified and why.
- Hygiene: no secrets, private endpoints, or machine-specific absolute paths in tracked files, commit messages, or PR bodies. Use absolute dates.
- Handoff: when a ruling is needed and the user is away, finish everything that does not depend on it, then stop with the exact question and a recommended answer.
