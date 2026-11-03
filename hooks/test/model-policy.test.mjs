import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_ALLOWED, HAIKU_REMINDER, SONNET_REMINDER, evaluate, modelFamily, parseFrontmatter, readAllowed, readMode, resolveAgent } from "../scripts/model-policy.mjs";

const hook = join(import.meta.dirname, "../scripts/model-policy.mjs");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const CLEAN_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("MODEL_POLICY_") && !["CLAUDE_CONFIG_DIR", "CLAUDE_PROJECT_DIR", "HOME"].includes(key)),
);

function tempDir(prefix = "claude-model-policy-test-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** A fresh HOME and project cwd with no agent definitions. */
function sandbox() {
	return { home: tempDir(), cwd: tempDir() };
}

function writeAgent(dir, file, frontmatter, body = "Agent body.\n") {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n${body}`);
}

function spawnHook(stdin, env = {}, box = sandbox()) {
	return spawnSync(process.execPath, [hook], {
		input: stdin,
		encoding: "utf8",
		cwd: box.cwd,
		env: { ...CLEAN_ENV, HOME: box.home, ...env },
	});
}

function run(input, env = {}, box = sandbox()) {
	const result = spawnHook(JSON.stringify({ cwd: box.cwd, ...input }), env, box);
	assert.equal(result.status, 0, result.stderr);
	return { output: result.stdout ? JSON.parse(result.stdout) : null, stdout: result.stdout, stderr: result.stderr };
}

const PROMPT = "SECRET-PROMPT-TEXT do the thing";
const launch = (tool_input, tool_name = "Agent") => ({
	hook_event_name: "PreToolUse",
	session_id: "s",
	tool_name,
	tool_input: { description: "d", prompt: PROMPT, ...tool_input },
});

const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision;
const reason = (result) => result.output?.hookSpecificOutput?.permissionDecisionReason;
const context = (result) => result.output?.hookSpecificOutput?.additionalContext;

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

test("readMode defaults to deny and honours MODEL_POLICY_MODE / MODEL_POLICY_DISABLED", () => {
	assert.equal(readMode({}), "deny");
	assert.equal(readMode({ MODEL_POLICY_MODE: " WARN " }), "warn");
	assert.equal(readMode({ MODEL_POLICY_MODE: "ask" }), "ask");
	assert.equal(readMode({ MODEL_POLICY_MODE: "off" }), "off");
	assert.equal(readMode({ MODEL_POLICY_MODE: "bogus" }), "deny");
	assert.equal(readMode({ MODEL_POLICY_MODE: "warn", MODEL_POLICY_DISABLED: "1" }), "off");
});

test("readAllowed defaults to opus,sonnet,haiku and normalises a custom list", () => {
	assert.deepEqual(DEFAULT_ALLOWED, ["opus", "sonnet", "haiku"]);
	assert.deepEqual(readAllowed({}), ["opus", "sonnet", "haiku"]);
	assert.deepEqual(readAllowed({ MODEL_POLICY_ALLOWED: " , " }), DEFAULT_ALLOWED);
	assert.deepEqual(readAllowed({ MODEL_POLICY_ALLOWED: "opus, Sonnet ,claude-haiku-4-5,opus" }), ["opus", "sonnet", "haiku"]);
});

test("modelFamily maps aliases and full model IDs to a family", () => {
	assert.equal(modelFamily("opus"), "opus");
	assert.equal(modelFamily("claude-opus-5-5"), "opus");
	assert.equal(modelFamily("claude-opus-5-5[1m]"), "opus");
	assert.equal(modelFamily("claude-sonnet-5"), "sonnet");
	assert.equal(modelFamily("us.anthropic.claude-sonnet-5-v1:0"), "sonnet");
	assert.equal(modelFamily("claude-3-5-sonnet-20241022"), "sonnet");
	assert.equal(modelFamily("claude-fable-5-1"), "fable");
	assert.equal(modelFamily("HAIKU"), "haiku");
	assert.equal(modelFamily("opusplan"), "opusplan");
	assert.equal(modelFamily("gpt-5"), "gpt-5");
	assert.equal(modelFamily(undefined), "");
});

test("parseFrontmatter reads name and model", () => {
	assert.deepEqual(parseFrontmatter("---\nname: reviewer\nmodel: opus\ntools: Read\n---\nbody"), { name: "reviewer", model: "opus" });
	assert.deepEqual(parseFrontmatter("---\r\nname: 'x'\r\nmodel: \"sonnet\" # pinned\r\n---\r\n"), { name: "x", model: "sonnet" });
	assert.deepEqual(parseFrontmatter("no frontmatter\nmodel: opus"), {});
	assert.deepEqual(parseFrontmatter("---\nname: x\n---\nmodel: opus"), { name: "x" });
});

test("evaluate ignores other events and tools", () => {
	assert.equal(evaluate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), null);
	assert.equal(evaluate({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {} }), null);
	assert.equal(evaluate(launch({ subagent_type: "fork" }), { mode: "off" }), null);
});

test("evaluate uses the injected resolver for pinned definitions", () => {
	const resolve = (type) => (type === "pinned" ? { label: "test", model: "claude-opus-5-5" } : null);
	assert.equal(evaluate(launch({ subagent_type: "pinned" }), { resolve }), null);
	assert.equal(evaluate(launch({ subagent_type: "other" }), { resolve }).hookSpecificOutput.permissionDecision, "deny");
});

test("resolveAgent finds this plugin's reviewer and rejects other plugins and unsafe names", () => {
	const reviewer = resolveAgent("dev-setup:reviewer", { cwd: tempDir(), env: { HOME: tempDir() } });
	assert.equal(reviewer.model, "sonnet");
	assert.equal(reviewer.label, "plugin agent dev-setup:reviewer");
	assert.equal(resolveAgent("other-plugin:reviewer", { env: { HOME: tempDir() } }), null);
	assert.equal(resolveAgent("dev-setup:../../etc/passwd", { env: { HOME: tempDir() } }), null);
	assert.equal(resolveAgent("../evil", { env: { HOME: tempDir() } }), null);
	assert.equal(resolveAgent("general-purpose", { cwd: tempDir(), env: { HOME: tempDir() } }), null);
});

test("resolveAgent prefers project over user definitions, walks up from cwd, and matches frontmatter names", () => {
	const { home, cwd } = sandbox();
	writeAgent(join(home, ".claude", "agents"), "worker.md", "name: worker\nmodel: haiku");
	assert.equal(resolveAgent("worker", { cwd, env: { HOME: home } }).model, "haiku");
	writeAgent(join(cwd, ".claude", "agents"), "worker.md", "name: worker\nmodel: opus");
	const nested = join(cwd, "a", "b");
	mkdirSync(nested, { recursive: true });
	const found = resolveAgent("worker", { cwd: nested, env: { HOME: home } });
	assert.equal(found.model, "opus");
	assert.equal(found.label, "project agent .claude/agents/worker.md");
	writeAgent(join(cwd, ".claude", "agents"), "some-file.md", "name: renamed\nmodel: sonnet");
	assert.equal(resolveAgent("renamed", { cwd, env: { HOME: home } }).model, "sonnet");
	const config = tempDir();
	writeAgent(join(config, "agents"), "cfg.md", "name: cfg\nmodel: opus");
	assert.equal(resolveAgent("cfg", { cwd: tempDir(), env: { HOME: home, CLAUDE_CONFIG_DIR: config } }).model, "opus");
});

// ---------------------------------------------------------------------------
// end to end: spawn the hook with JSON on stdin
// ---------------------------------------------------------------------------

test("explicit opus is allowed silently", () => {
	const result = run(launch({ subagent_type: "general-purpose", model: "opus" }));
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
});

test("explicit sonnet is allowed with an implementation/initial-review note", () => {
	const result = run(launch({ subagent_type: "general-purpose", model: "sonnet" }));
	assert.equal(result.output.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(decision(result), undefined);
	assert.match(context(result), /implementation/);
	assert.match(context(result), /candidates until an opus run verifies/);
});

test("explicit haiku (alias and full IDs) is allowed with a context-collection note", () => {
	for (const model of ["haiku", "claude-haiku-5-5", "claude-haiku-4-5"]) {
		const result = run(launch({ subagent_type: "Explore", model }));
		assert.equal(result.output.hookSpecificOutput.hookEventName, "PreToolUse");
		assert.equal(decision(result), undefined, model);
		assert.match(context(result), /context collection and mechanical work only/, model);
		assert.match(context(result), /[Ss]pot-check/, model);
	}
});

test("fable, unknown families and opusplan are denied with a reason naming all three tiers", () => {
	for (const model of ["fable", "claude-fable-5-1", "opusplan", "gpt-5"]) {
		const result = run(launch({ subagent_type: "general-purpose", model }));
		assert.equal(result.output.hookSpecificOutput.hookEventName, "PreToolUse");
		assert.equal(decision(result), "deny", model);
		assert.match(reason(result), /not allowed for subagents \(allowed: opus, sonnet, haiku\)/);
		assert.match(reason(result), /model "haiku"/);
		assert.match(reason(result), /"sonnet"/);
		assert.match(reason(result), /"opus"/);
		assert.match(reason(result), /Other models require the user's explicit request/);
	}
});

test("full model IDs are treated as their family", () => {
	assert.equal(run(launch({ subagent_type: "general-purpose", model: "claude-opus-5-5" })).output, null);
	assert.equal(run(launch({ subagent_type: "general-purpose", model: "claude-opus-5-5[1m]" })).output, null);
	assert.match(context(run(launch({ subagent_type: "general-purpose", model: "claude-sonnet-5" }))), /implementation/);
	assert.match(context(run(launch({ subagent_type: "general-purpose", model: "claude-haiku-5-5" }))), /context collection/);
	assert.equal(decision(run(launch({ subagent_type: "general-purpose", model: "claude-fable-5-1" }))), "deny");
});

test("a missing model on built-in agents is denied", () => {
	for (const subagent_type of ["general-purpose", "Explore", "Plan", "claude", undefined]) {
		const result = run(launch({ subagent_type }));
		assert.equal(decision(result), "deny", String(subagent_type));
		assert.match(reason(result), /without an explicit model/);
		assert.match(reason(result), /inherit the orchestrator's model/);
	}
	assert.equal(decision(run(launch({ subagent_type: "general-purpose", model: "inherit" }))), "deny");
});

test("fork is denied even with an explicit model", () => {
	for (const model of [undefined, "opus"]) {
		const result = run(launch({ subagent_type: "fork", model }));
		assert.equal(decision(result), "deny");
		assert.match(reason(result), /forks inherit the orchestrator's model/);
		assert.match(reason(result), /general-purpose/);
		assert.match(reason(result), /"haiku"/);
		assert.match(reason(result), /"sonnet"/);
		assert.match(reason(result), /"opus"/);
	}
});

test("dev-setup:reviewer without a model is allowed via its pinned frontmatter", () => {
	const result = run(launch({ subagent_type: "dev-setup:reviewer" }));
	assert.equal(decision(result), undefined);
	assert.match(context(result), /initial reviews/);
	assert.equal(run(launch({ subagent_type: "dev-setup:adversarial-reviewer" })).stdout, "");
	assert.equal(decision(run(launch({ subagent_type: "dev-setup:unknown-agent" }))), "deny");
	assert.equal(decision(run(launch({ subagent_type: "other-plugin:reviewer" }))), "deny");
});

test("project agent definitions: pinned opus and haiku allowed, inherit denied", () => {
	const box = sandbox();
	const dir = join(box.cwd, ".claude", "agents");
	writeAgent(dir, "pinned.md", "name: pinned\ndescription: x\nmodel: opus");
	writeAgent(dir, "inherits.md", "name: inherits\ndescription: x\nmodel: inherit");
	writeAgent(dir, "unpinned.md", "name: unpinned\ndescription: x");
	writeAgent(dir, "cheap.md", "name: cheap\ndescription: x\nmodel: haiku");
	assert.equal(run(launch({ subagent_type: "pinned" }), {}, box).output, null);
	const inherits = run(launch({ subagent_type: "inherits" }), {}, box);
	assert.equal(decision(inherits), "deny");
	assert.match(reason(inherits), /does not pin a model \(model: inherit\)/);
	assert.equal(decision(run(launch({ subagent_type: "unpinned" }), {}, box)), "deny");
	const cheap = run(launch({ subagent_type: "cheap" }), {}, box);
	assert.equal(decision(cheap), undefined);
	assert.match(context(cheap), /context collection/);
	// A pin outside a narrowed allowed set is denied; an explicit allowed model overrides it.
	const narrowed = run(launch({ subagent_type: "cheap" }), { MODEL_POLICY_ALLOWED: "opus,sonnet" }, box);
	assert.equal(decision(narrowed), "deny");
	assert.match(reason(narrowed), /pins model "haiku"/);
	assert.match(reason(narrowed), /allowed: opus, sonnet\)/);
	assert.equal(run(launch({ subagent_type: "cheap", model: "opus" }), { MODEL_POLICY_ALLOWED: "opus,sonnet" }, box).output, null);
});

test("user agent definitions: pinned opus, sonnet and haiku allowed, inherit denied", () => {
	const box = sandbox();
	const dir = join(box.home, ".claude", "agents");
	writeAgent(dir, "pinned.md", "name: pinned\nmodel: claude-opus-5-5");
	writeAgent(dir, "inherits.md", "name: inherits\nmodel: inherit");
	writeAgent(dir, "cheap.md", "name: cheap\nmodel: haiku");
	writeAgent(dir, "helper.md", "name: helper\nmodel: sonnet");
	assert.equal(run(launch({ subagent_type: "pinned" }), {}, box).output, null);
	assert.equal(decision(run(launch({ subagent_type: "inherits" }), {}, box)), "deny");
	assert.match(context(run(launch({ subagent_type: "cheap" }), {}, box)), /context collection/);
	assert.match(context(run(launch({ subagent_type: "helper" }), {}, box)), /implementation/);
	assert.equal(decision(run(launch({ subagent_type: "cheap" }), { MODEL_POLICY_ALLOWED: "opus,sonnet" }, box)), "deny");
});

test("warn mode allows with additionalContext; ask mode asks; off and DISABLED are silent", () => {
	const warned = run(launch({ subagent_type: "general-purpose", model: "fable" }), { MODEL_POLICY_MODE: "warn" });
	assert.equal(decision(warned), undefined);
	assert.match(context(warned), /not allowed for subagents/);
	const asked = run(launch({ subagent_type: "fork" }), { MODEL_POLICY_MODE: "ask" });
	assert.equal(decision(asked), "ask");
	assert.match(reason(asked), /fork/);
	for (const env of [{ MODEL_POLICY_MODE: "off" }, { MODEL_POLICY_DISABLED: "1", MODEL_POLICY_MODE: "deny" }]) {
		const result = run(launch({ subagent_type: "fork", model: "fable" }), env);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
	}
});

test("MODEL_POLICY_ALLOWED widens and narrows the allowed set", () => {
	const env = { MODEL_POLICY_ALLOWED: "opus,sonnet,haiku,fable" };
	assert.match(context(run(launch({ subagent_type: "general-purpose", model: "haiku" }), env)), /context collection/);
	assert.equal(run(launch({ subagent_type: "general-purpose", model: "fable" }), env).output, null);
	assert.equal(decision(run(launch({ subagent_type: "general-purpose", model: "opusplan" }), env)), "deny");
	const noHaiku = run(launch({ subagent_type: "general-purpose", model: "haiku" }), { MODEL_POLICY_ALLOWED: "opus,sonnet" });
	assert.equal(decision(noHaiku), "deny");
	assert.match(reason(noHaiku), /allowed: opus, sonnet\)/);
	const narrowed = run(launch({ subagent_type: "general-purpose", model: "sonnet" }), { MODEL_POLICY_ALLOWED: "opus" });
	assert.equal(decision(narrowed), "deny");
	assert.match(reason(narrowed), /allowed: opus\)/);
});

test("the legacy Task tool name is handled; other tools are ignored", () => {
	assert.equal(decision(run(launch({ subagent_type: "general-purpose" }, "Task"))), "deny");
	assert.equal(run(launch({ subagent_type: "general-purpose", model: "opus" }, "Task")).output, null);
	assert.equal(run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }).output, null);
});

test("the subagent prompt is never echoed", () => {
	for (const input of [launch({ subagent_type: "fork" }), launch({ model: "fable" }), launch({ model: "haiku" }), launch({ model: "sonnet" })]) {
		for (const mode of ["deny", "warn", "ask"]) {
			const result = run(input, { MODEL_POLICY_MODE: mode });
			assert.doesNotMatch(result.stdout + result.stderr, /SECRET-PROMPT-TEXT/);
		}
	}
});

test("malformed stdin fails open with a bounded diagnostic", () => {
	for (const stdin of ["not-json", "null", "[1", "[]", "42"]) {
		const result = spawnHook(stdin);
		assert.equal(result.status, 0, stdin);
		assert.equal(result.stdout, "", stdin);
		assert.match(result.stderr, /^model-policy: invalid input; proceeding\n$/, stdin);
	}
});

test("unexpected input shapes fail open", () => {
	for (const input of [
		{},
		{ hook_event_name: "PreToolUse" },
		{ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: "nope", cwd: 42 },
		{ hook_event_name: "Stop" },
	]) {
		const result = spawnHook(JSON.stringify(input));
		assert.equal(result.status, 0, JSON.stringify(input));
		assert.doesNotMatch(result.stderr, /internal error/, JSON.stringify(input));
	}
});

test("importing the module does not run the hook", () => {
	const box = sandbox();
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(hook)}); console.log("imported")`], {
		input: JSON.stringify(launch({ subagent_type: "fork" })),
		encoding: "utf8",
		env: { ...CLEAN_ENV, HOME: box.home },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "imported\n");
});

test("every plugin agent pins a model in the default allowed set, matching the routing table", () => {
	const expected = {
		reviewer: "sonnet",
		"adversarial-reviewer": "opus",
		"audit-verifier": "opus",
		worker: "sonnet",
		"repo-explorer": "haiku",
		"github-researcher": "haiku",
		"web-researcher": "haiku",
	};
	const dir = join(import.meta.dirname, "../../agents");
	const actual = {};
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
		const fields = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
		assert.equal(fields.name, file.replace(/\.md$/, ""), file);
		assert.ok(DEFAULT_ALLOWED.includes(modelFamily(fields.model)), `${file} pins ${fields.model}`);
		actual[fields.name] = fields.model;
	}
	assert.deepEqual(actual, expected);
});

test("deny remediation only recommends families in the effective allowed set", () => {
	const resolve = (type) => (type === "cheap" ? { label: "test agent", model: "haiku" } : type === "big" ? { label: "test agent", model: "opus" } : null);
	const sets = [["opus", "sonnet"], ["opus"], ["sonnet", "haiku"], ["haiku"]];
	for (const allowed of sets) {
		const denied = ["opus", "sonnet", "haiku"].filter((family) => !allowed.includes(family));
		const launches = [
			launch({ subagent_type: "general-purpose", model: "fable" }),
			launch({ subagent_type: "general-purpose" }),
			launch({ subagent_type: "fork" }),
			launch({ subagent_type: "fork", model: "opus" }),
			launch({ subagent_type: "cheap" }),
			launch({ subagent_type: "big" }),
			launch({ subagent_type: "general-purpose", model: "haiku" }),
			launch({ subagent_type: "general-purpose", model: "opus" }),
			launch({ subagent_type: "general-purpose", model: "sonnet" }),
		];
		for (const input of launches) {
			const out = evaluate(input, { allowed, resolve });
			const text = out?.hookSpecificOutput?.permissionDecisionReason;
			if (!text) continue;
			// Strip the "(allowed: ...)" listing and quoted echo of the caller's own model/type before checking.
			const advice = text.replace(/\(allowed:[^)]*\)/, "").replace(/model "[^"]*" is not allowed/, "").replace(/pins model "[^"]*"/, "").replace(/\(model: [^)]*\)/, "");
			for (const family of denied) {
				assert.doesNotMatch(advice, new RegExp(`"${family}"`), `${allowed} recommends ${family}: ${text}`);
			}
			for (const family of allowed) {
				assert.match(advice, new RegExp(`"${family}"`), `${allowed} omits ${family}: ${text}`);
			}
		}
	}
	const pinned = evaluate(launch({ subagent_type: "cheap" }), { allowed: ["opus", "sonnet"], resolve });
	assert.match(pinned.hookSpecificOutput.permissionDecisionReason, /Pass an explicit allowed model/);
});

test("allow-path notes, mixed sets and pinned substitutes follow the effective allowed set", () => {
	const ctx = (input, allowed, resolve) => evaluate(input, { allowed, resolve })?.hookSpecificOutput;
	const reason = (input, allowed, resolve) => ctx(input, allowed, resolve)?.permissionDecisionReason;
	const haiku = launch({ subagent_type: "general-purpose", model: "haiku" });
	const sonnet = launch({ subagent_type: "general-purpose", model: "sonnet" });

	// Default-config notes are unchanged.
	assert.equal(ctx(haiku, DEFAULT_ALLOWED).additionalContext, HAIKU_REMINDER);
	assert.equal(ctx(sonnet, DEFAULT_ALLOWED).additionalContext, SONNET_REMINDER);
	assert.match(HAIKU_REMINDER, /use sonnet for implementation and initial reviews, and opus for adversarial review and verification\.$/);

	// Narrowed sets: notes never recommend a denied tier.
	const haikuOpus = ctx(haiku, ["haiku", "opus"]).additionalContext;
	assert.doesNotMatch(haikuOpus, /sonnet/);
	assert.match(haikuOpus, /use opus for adversarial review and verification/);
	const sonnetHaiku = ctx(sonnet, ["sonnet", "haiku"]).additionalContext;
	assert.doesNotMatch(sonnetHaiku, /opus/);
	const haikuOnly = ctx(haiku, ["haiku"]).additionalContext;
	assert.doesNotMatch(haikuOnly, /sonnet|opus/);

	// Mixed sets: non-tier families are listed too.
	for (const allowed of [["haiku", "fable"], ["opus", "sonnet", "haiku", "fable"]]) {
		const text = reason(launch({ subagent_type: "general-purpose" }), allowed);
		assert.match(text, /"fable"/);
		for (const family of allowed) assert.match(text, new RegExp(`"${family}"`));
	}

	// Pinned agents: closest allowed tier first, and nothing denied is recommended.
	const resolve = (type) => ({ label: "plugin agent", model: { explorer: "haiku", worker: "sonnet" }[type] });
	const explorer = reason(launch({ subagent_type: "explorer" }), ["opus", "sonnet"], resolve);
	assert.match(explorer, /closest tier first: "sonnet", "opus"\./);
	const worker = reason(launch({ subagent_type: "worker" }), ["opus"], resolve);
	assert.match(worker, /closest tier first: "opus"\./);
	assert.doesNotMatch(worker.replace(/pins model "[^"]*"/, ""), /"sonnet"|"haiku"/);
	const workerHaiku = reason(launch({ subagent_type: "worker" }), ["haiku", "opus"], resolve);
	assert.match(workerHaiku, /closest tier first: "opus", "haiku"\./);
});
