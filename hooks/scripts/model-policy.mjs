#!/usr/bin/env node

/**
 * Model Policy Hook
 *
 * Enforces the subagent model rule from policy/session-policy.md on every
 * subagent launch (PreToolUse on the `Agent` tool; `Task` is its older name):
 *
 *  - `fork` subagents are disallowed: they inherit the orchestrator's model
 *    and ignore `model`.
 *  - An explicit `model` must be allowed (default `opus,sonnet,haiku`), giving
 *    three tiers:
 *      haiku  — context collection and mechanical work (allowed with a note to
 *               spot-check claims a decision depends on)
 *      sonnet — everything in between: implementation, editing, planning, and
 *               initial reviews (allowed with a note that its review findings
 *               are candidates until opus verifies them)
 *      opus   — adversarial and verification work (allowed silently)
 *    Other models (e.g. fable) are denied. Full model IDs map to their family
 *    (`claude-opus-5-5[1m]` -> opus).
 *  - With no `model`, the launch is allowed only when the agent definition for
 *    `subagent_type` pins an allowed model in its frontmatter (`inherit` does
 *    not count). Definitions are looked up as:
 *      <this plugin>:<name> -> <plugin root>/agents/<name>.md
 *      <name>               -> <cwd and its parents>/.claude/agents/<name>.md,
 *                              then $CLAUDE_CONFIG_DIR/agents or ~/.claude/agents
 *    Built-in agents (general-purpose, Explore, Plan, ...) and other plugins'
 *    agents have no definition here, so they need an explicit `model`.
 *
 * Violations are handled per `MODEL_POLICY_MODE`:
 *   deny (default) — block with an actionable reason
 *   warn           — allow, but inject the reason as additionalContext
 *   ask            — surface a permission prompt to the human
 *   off            — disable the policy entirely (also: MODEL_POLICY_DISABLED=1)
 * `MODEL_POLICY_ALLOWED` (comma list, default `opus,sonnet,haiku`) widens or narrows the set.
 *
 * Fails open: malformed input or any internal error lets the launch proceed
 * (empty stdout, one line on stderr). Never echoes the subagent prompt.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_ALLOWED = ["opus", "sonnet", "haiku"];

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MODES = new Set(["deny", "warn", "ask", "off"]);
const SUBAGENT_TOOLS = new Set(["agent", "task"]);
const AGENT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_PARENT_DIRS = 64;
const MAX_DEFINITION_BYTES = 256 * 1024;

const TIER_ROLES = [
	["haiku", "context collection and mechanical work"],
	["sonnet", "implementation, planning, and initial reviews"],
	["opus", "adversarial review and verification"],
];
const TIER_NAMES = TIER_ROLES.map(([family]) => family);

/** Substitute order (closest tier first) when an agent's pinned family is denied. */
const SUBSTITUTES = {
	haiku: ["sonnet", "opus"],
	sonnet: ["opus", "haiku"],
	opus: ["sonnet", "haiku"],
};

/** Sonnet allow-path note; cross-tier advice names only allowed tiers. */
export function sonnetReminder(allowed = DEFAULT_ALLOWED) {
	const opus = allowed.includes("opus");
	return (
		"Model policy: sonnet is for implementation, editing, planning, and initial reviews. " +
		(opus
			? "Its review findings are candidates until an opus run verifies them; use opus for adversarial review and verification."
			: "Its review findings are candidates until independently verified.")
	);
}

/** Haiku allow-path note; cross-tier advice names only allowed tiers. */
export function haikuReminder(allowed = DEFAULT_ALLOWED) {
	const advice = [];
	if (allowed.includes("sonnet")) advice.push("sonnet for implementation and initial reviews");
	if (allowed.includes("opus")) advice.push("opus for adversarial review and verification");
	return (
		"Model policy: haiku is for context collection and mechanical work only. " +
		"Spot-check every claim from this run that a decision depends on" +
		(advice.length ? `; use ${advice.join(", and ")}.` : ".")
	);
}

export const SONNET_REMINDER = sonnetReminder(DEFAULT_ALLOWED);
export const HAIKU_REMINDER = haikuReminder(DEFAULT_ALLOWED);

const quoted = (family) => `"${family}"`;

/** Every allowed family: tiers with their roles, then any other allowed family plainly. */
function tierList(allowed) {
	const parts = [
		...TIER_ROLES.filter(([family]) => allowed.includes(family)).map(([family, role]) => `${quoted(family)} for ${role}`),
		...allowed.filter((family) => !TIER_NAMES.includes(family)).map(quoted),
	];
	if (!parts.length) return `a model from the allowed set (${allowedText(allowed)})`;
	if (parts.length === 1) return parts[0];
	return `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} or ${parts[parts.length - 1]}`;
}

function howToFix(allowed) {
	return `Relaunch with model ${tierList(allowed)}.`;
}

/** Remediation for a denied pinned agent: allowed families, closest substitute tier first. */
function pinnedFix(allowed, pinned) {
	const order = SUBSTITUTES[pinned] ?? ["sonnet", "opus", "haiku"];
	const families = [...order.filter((family) => allowed.includes(family)), ...allowed.filter((family) => !TIER_NAMES.includes(family))];
	if (!families.length) return howToFix(allowed);
	return `Pass an explicit allowed model for this agent's work, closest tier first: ${families.map(quoted).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export function readMode(env = process.env) {
	if (env.MODEL_POLICY_DISABLED === "1") return "off";
	const mode = String(env.MODEL_POLICY_MODE || "deny").trim().toLowerCase();
	return MODES.has(mode) ? mode : "deny";
}

export function readAllowed(env = process.env) {
	const list = String(env.MODEL_POLICY_ALLOWED ?? "")
		.split(",")
		.map(modelFamily)
		.filter(Boolean);
	return list.length ? [...new Set(list)] : [...DEFAULT_ALLOWED];
}

/**
 * Map a model alias or full ID to its family: "claude-opus-5-5[1m]" -> "opus",
 * "us.anthropic.claude-sonnet-5-v1:0" -> "sonnet". Unknown values are returned
 * lowercased as-is; "" for empty.
 */
export function modelFamily(model) {
	const value = String(model ?? "").trim().toLowerCase();
	if (!value) return "";
	const match = value.match(/(?:^|[^a-z])(opus|sonnet|haiku|fable)(?![a-z])/);
	return match ? match[1] : value;
}

/** An explicit model counts as absent when empty or "inherit". */
function isUnset(model) {
	const family = modelFamily(model);
	return family === "" || family === "inherit";
}

// ---------------------------------------------------------------------------
// agent definitions
// ---------------------------------------------------------------------------

/** Parse `name` and `model` from Markdown frontmatter (simple `key: value` lines). */
export function parseFrontmatter(text) {
	const match = String(text ?? "").match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	if (!match) return {};
	const fields = {};
	for (const line of match[1].split(/\r?\n/)) {
		const field = line.match(/^(name|model)[ \t]*:[ \t]*(.*)$/);
		if (!field) continue;
		let value = field[2].replace(/[ \t]+#.*$/, "").trim();
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).trim();
		fields[field[1]] = value;
	}
	return fields;
}

function readDefinition(path) {
	const text = readFileSync(path, "utf8");
	return text.length > MAX_DEFINITION_BYTES ? text.slice(0, MAX_DEFINITION_BYTES) : text;
}

/** Find `<name>` in an agents directory: `<name>.md`, else any *.md whose frontmatter name matches. */
function findInDir(dir, name) {
	try {
		const fields = parseFrontmatter(readDefinition(join(dir, `${name}.md`)));
		if (!fields.name || fields.name === name) return { path: join(dir, `${name}.md`), ...fields };
	} catch {
		/* not there by filename */
	}
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		try {
			const fields = parseFrontmatter(readDefinition(join(dir, entry)));
			if (fields.name === name) return { path: join(dir, entry), ...fields };
		} catch {
			/* unreadable entry */
		}
	}
	return null;
}

function pluginName(pluginRoot) {
	try {
		return JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).name || "dev-setup";
	} catch {
		return "dev-setup";
	}
}

function* ancestors(start) {
	let dir = start;
	for (let i = 0; i < MAX_PARENT_DIRS && dir; i++) {
		yield dir;
		const parent = dirname(dir);
		if (parent === dir || dir === parsePath(dir).root) return;
		dir = parent;
	}
}

/**
 * Resolve an agent definition to { path, label, name?, model? } or null.
 * `label` is a short, non-sensitive description of where it was found.
 */
export function resolveAgent(subagentType, { cwd, env = process.env, pluginRoot = PLUGIN_ROOT } = {}) {
	const type = String(subagentType ?? "");
	const colon = type.indexOf(":");
	if (colon !== -1) {
		const plugin = type.slice(0, colon);
		const name = type.slice(colon + 1);
		if (plugin !== pluginName(pluginRoot) || !AGENT_NAME.test(name)) return null;
		const found = findInDir(join(pluginRoot, "agents"), name);
		return found && { ...found, label: `plugin agent ${plugin}:${name}` };
	}
	if (!AGENT_NAME.test(type)) return null;

	const projectRoots = [];
	if (cwd) projectRoots.push(...ancestors(String(cwd)));
	if (env.CLAUDE_PROJECT_DIR && !projectRoots.includes(env.CLAUDE_PROJECT_DIR)) projectRoots.push(env.CLAUDE_PROJECT_DIR);
	for (const root of projectRoots) {
		const found = findInDir(join(root, ".claude", "agents"), type);
		if (found) return { ...found, label: `project agent ${relative(root, found.path) || found.path}` };
	}

	const home = env.HOME || homedir();
	const userDir = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "agents") : join(home, ".claude", "agents");
	const found = findInDir(userDir, type);
	return found && { ...found, label: `user agent ~/.claude/agents/${found.path.split(/[\\/]/).pop()}` };
}

// ---------------------------------------------------------------------------
// decision
// ---------------------------------------------------------------------------

function allowedText(allowed) {
	return allowed.join(", ");
}

function violation(mode, reason) {
	if (mode === "warn") {
		return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: reason } };
	}
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: mode === "ask" ? "ask" : "deny",
			permissionDecisionReason: reason,
		},
	};
}

function note(context) {
	return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } };
}

/** Allowed family -> null (silent, opus) or a tier note; disallowed -> undefined. */
function allowedOutcome(family, allowed) {
	if (!allowed.includes(family)) return undefined;
	if (family === "sonnet") return note(sonnetReminder(allowed));
	if (family === "haiku") return note(haikuReminder(allowed));
	return null;
}

/**
 * Pure decision function.
 * @param input   Claude Code hook input (hook_event_name, tool_name, tool_input, cwd, ...)
 * @param options { mode, allowed, resolve(subagentType) -> definition | null }
 * @returns hook output object, or null to allow silently
 */
export function evaluate(input, { mode = "deny", allowed = DEFAULT_ALLOWED, resolve = () => null } = {}) {
	if (mode === "off" || !input || typeof input !== "object") return null;
	if ((input.hook_event_name ?? input.event) !== "PreToolUse") return null;
	if (!SUBAGENT_TOOLS.has(String(input.tool_name ?? "").toLowerCase())) return null;

	const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
	const type = typeof toolInput.subagent_type === "string" && toolInput.subagent_type.trim() ? toolInput.subagent_type.trim() : "general-purpose";

	if (type.toLowerCase() === "fork") {
		return violation(
			mode,
			'Model policy: `fork` subagents are not allowed — forks inherit the orchestrator\'s model and ignore `model`. ' +
				'Relaunch as subagent_type "general-purpose" with a self-contained prompt and an explicit model: ' +
				tierList(allowed) + ".",
		);
	}

	if (!isUnset(toolInput.model)) {
		const family = modelFamily(toolInput.model);
		const outcome = allowedOutcome(family, allowed);
		if (outcome !== undefined) return outcome;
		return violation(
			mode,
			`Model policy: model ${JSON.stringify(String(toolInput.model))} is not allowed for subagents (allowed: ${allowedText(allowed)}). ${howToFix(allowed)} ` +
				"Other models require the user's explicit request.",
		);
	}

	const definition = resolve(type);
	const pinned = definition && !isUnset(definition.model) ? modelFamily(definition.model) : "";
	if (pinned) {
		const outcome = allowedOutcome(pinned, allowed);
		if (outcome !== undefined) return outcome;
		return violation(
			mode,
			`Model policy: subagent_type ${JSON.stringify(type)} (${definition.label}) pins model ${JSON.stringify(definition.model)}, ` +
				`which is not allowed (allowed: ${allowedText(allowed)}). ${pinnedFix(allowed, pinned)}`,
		);
	}

	const why = definition
		? `its definition (${definition.label}) does not pin a model${definition.model ? ` (model: ${definition.model})` : ""}`
		: "no agent definition pinning a model was found for it (built-in agents never pin one)";
	return violation(
		mode,
		`Model policy: subagent_type ${JSON.stringify(type)} was launched without an explicit model and ${why}, ` +
			`so it would inherit the orchestrator's model. ${howToFix(allowed)}`,
	);
}

// ---------------------------------------------------------------------------
// I/O (best effort; every failure falls through to "allow")
// ---------------------------------------------------------------------------

function diagnostic(code) {
	try {
		process.stderr.write(`model-policy: ${code}; proceeding\n`);
	} catch {
		/* never include input or the prompt */
	}
}

export function main(env = process.env) {
	let input;
	try {
		input = JSON.parse(readFileSync(0, "utf8") || "{}");
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object");
	} catch {
		diagnostic("invalid input");
		return;
	}
	try {
		const mode = readMode(env);
		if (mode === "off") return;
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
		const output = evaluate(input, {
			mode,
			allowed: readAllowed(env),
			resolve: (type) => resolveAgent(type, { cwd, env }),
		});
		if (output) process.stdout.write(JSON.stringify(output));
	} catch {
		// Never let a policy error block real work.
		diagnostic("internal error");
	}
}

function isEntrypoint() {
	try {
		return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isEntrypoint()) main();
