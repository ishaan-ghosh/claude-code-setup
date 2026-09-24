import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_POLICY_CHARS, POLICY_PATH, boundPolicy, buildOutput, isDisabled } from "../scripts/session-policy.mjs";

const hook = join(import.meta.dirname, "../scripts/session-policy.mjs");
const policyFile = join(import.meta.dirname, "../../policy/session-policy.md");

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SESSION_POLICY_")));

function spawnHook(script = hook, env = {}, stdin = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s" })) {
	return spawnSync(process.execPath, [script], { input: stdin, encoding: "utf8", env: { ...CLEAN_ENV, ...env } });
}

/** Copy the hook into a temp plugin layout (hooks/scripts/), optionally with a policy file. */
function tempPlugin(policy) {
	const root = mkdtempSync(join(tmpdir(), "claude-session-policy-test-"));
	mkdirSync(join(root, "hooks", "scripts"), { recursive: true });
	const script = join(root, "hooks", "scripts", "session-policy.mjs");
	copyFileSync(hook, script);
	if (policy !== undefined) {
		mkdirSync(join(root, "policy"));
		writeFileSync(join(root, "policy", "session-policy.md"), policy);
	}
	return script;
}

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

test("POLICY_PATH resolves to the repository policy file", () => {
	assert.equal(POLICY_PATH, policyFile);
});

test("isDisabled honours SESSION_POLICY_DISABLED=1 only", () => {
	assert.equal(isDisabled({}), false);
	assert.equal(isDisabled({ SESSION_POLICY_DISABLED: "0" }), false);
	assert.equal(isDisabled({ SESSION_POLICY_DISABLED: "1" }), true);
});

test("boundPolicy trims and truncates with a marker", () => {
	assert.equal(boundPolicy("  hi \n"), "hi");
	const long = boundPolicy("x".repeat(MAX_POLICY_CHARS * 2));
	assert.equal(long.length, MAX_POLICY_CHARS);
	assert.match(long, /\[session policy truncated\]$/);
});

test("buildOutput wraps the text in a SessionStart envelope and skips empty text", () => {
	assert.deepEqual(buildOutput("policy"), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "policy" } });
	assert.equal(buildOutput("  \n"), null);
});

// ---------------------------------------------------------------------------
// end to end: spawn the hook
// ---------------------------------------------------------------------------

test("emits the repository policy text as SessionStart additionalContext", () => {
	const result = spawnHook();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const output = JSON.parse(result.stdout);
	assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
	assert.equal(output.hookSpecificOutput.additionalContext, readFileSync(policyFile, "utf8").trim());
	assert.match(output.hookSpecificOutput.additionalContext, /MODEL_POLICY_MODE/);
	assert.ok(output.hookSpecificOutput.additionalContext.length <= MAX_POLICY_CHARS);
});

test("resolves the policy relative to the script, not the working directory", () => {
	const script = tempPlugin("# temp policy\n\nuse opus");
	const result = spawnSync(process.execPath, [script], { input: "{}", encoding: "utf8", cwd: tmpdir(), env: CLEAN_ENV });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "# temp policy\n\nuse opus");
});

test("truncates an oversized policy file", () => {
	const result = spawnHook(tempPlugin("y".repeat(50_000)));
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext.length, MAX_POLICY_CHARS);
});

test("SESSION_POLICY_DISABLED=1 emits nothing", () => {
	const result = spawnHook(hook, { SESSION_POLICY_DISABLED: "1" });
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
});

test("a missing policy file fails open with a one-line diagnostic", () => {
	const result = spawnHook(tempPlugin());
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^session-policy: policy file unreadable; proceeding\n$/);
});

test("an empty policy file emits nothing", () => {
	const result = spawnHook(tempPlugin("\n\n"));
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
});

test("malformed stdin does not matter", () => {
	const result = spawnHook(hook, {}, "not-json");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
});

test("importing the module does not run the hook", () => {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(hook)}); console.log("imported")`], {
		encoding: "utf8",
		env: CLEAN_ENV,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "imported\n");
});
