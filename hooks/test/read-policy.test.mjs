import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	MAX_READ_LIMIT,
	analyzeShellCommand,
	currentState,
	evaluate,
	isBoundedRead,
	isFullFileRequest,
	readMode,
} from "../scripts/read-policy.mjs";

const hook = join(import.meta.dirname, "../scripts/read-policy.mjs");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function newData() {
	return mkdtempSync(join(tmpdir(), "claude-read-policy-test-"));
}

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("READ_POLICY_") && key !== "CLAUDE_PLUGIN_DATA"));

function spawnHook(stdin, env = {}, data = newData()) {
	const result = spawnSync(process.execPath, [hook], {
		input: stdin,
		encoding: "utf8",
		env: { ...CLEAN_ENV, CLAUDE_PLUGIN_DATA: data, ...env },
	});
	return { ...result, data };
}

function run(input, env = {}, data = newData()) {
	const result = spawnHook(JSON.stringify(input), env, data);
	assert.equal(result.status, 0, result.stderr);
	return { output: result.stdout ? JSON.parse(result.stdout) : null, data, stderr: result.stderr };
}

const prompt = (text = "inspect the code", session = "s") => ({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: text });
const tool = (tool_name, tool_input, session = "s") => ({ hook_event_name: "PreToolUse", session_id: session, tool_name, tool_input });
const read = (extra = {}, session = "s") => tool("Read", { file_path: "/repo/x.txt", ...extra }, session);
const bash = (command, session = "s") => tool("Bash", { command }, session);

const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision;
const context = (result) => result.output?.hookSpecificOutput?.additionalContext;

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

test("readMode honours READ_POLICY_MODE and READ_POLICY_DISABLED", () => {
	assert.equal(readMode({}), "warn");
	assert.equal(readMode({ READ_POLICY_MODE: " DENY " }), "deny");
	assert.equal(readMode({ READ_POLICY_MODE: "ask" }), "ask");
	assert.equal(readMode({ READ_POLICY_MODE: "off" }), "off");
	assert.equal(readMode({ READ_POLICY_MODE: "bogus" }), "warn");
	assert.equal(readMode({ READ_POLICY_MODE: "deny", READ_POLICY_DISABLED: "1" }), "off");
});

test("isBoundedRead requires 0 < limit <= MAX_READ_LIMIT", () => {
	assert.equal(isBoundedRead({ file_path: "a.ts", limit: MAX_READ_LIMIT }), true);
	assert.equal(isBoundedRead({ file_path: "a.ts", limit: 50, offset: 900 }), true);
	assert.equal(isBoundedRead({ file_path: "a.ts", limit: MAX_READ_LIMIT + 1 }), false);
	assert.equal(isBoundedRead({ file_path: "a.ts", limit: 0 }), false);
	assert.equal(isBoundedRead({ file_path: "a.ts", limit: "10" }), false);
	assert.equal(isBoundedRead({ file_path: "a.ts", offset: 10 }), false);
	assert.equal(isBoundedRead({ file_path: "shot.png" }), true);
	assert.equal(isBoundedRead({ file_path: "doc.pdf", pages: "1-3" }), true);
	assert.equal(isBoundedRead({ file_path: "doc.pdf" }), false);
});

test("isFullFileRequest recognises explicit whole-file asks only", () => {
	for (const yes of [
		"read the entire file",
		"Please open the full file src/a.ts",
		"inspect the whole contents",
		"show me the complete file",
		"I need the full file",
		"dump all of the contents",
		"read config.yaml in full",
		"read it in its entirety",
		"go through every line of the file",
	]) {
		assert.equal(isFullFileRequest(yes), true, yes);
	}
	for (const no of ["inspect the code", "fix the bug in parser.ts", "full test suite please", "read the docs"]) {
		assert.equal(isFullFileRequest(no), false, no);
	}
});

test("analyzeShellCommand classifies searches and unbounded reads", () => {
	const unbounded = (command) => analyzeShellCommand(command).unboundedReads.length > 0;
	const search = (command) => analyzeShellCommand(command).search;

	for (const command of ["rg foo", "rg -n needle src", "grep -R x .", "find . -name '*.ts'", "fd pat", "ls -la", "tree src", "git grep foo", "git ls-files", "ls | wc -l"]) {
		assert.equal(search(command), true, command);
		assert.equal(unbounded(command), false, command);
	}
	for (const command of [
		"cat file",
		"cat big.txt | rg needle",
		"rg needle src; cat src/other.ts",
		"head -n 50 a; cat b",
		"FOO=1 cat file",
		"FOO=1 BAR=2 cat file",
		"sudo cat file",
		"sudo -u root cat file",
		"env -i A=1 cat file",
		"command cat file",
		"builtin cat file",
		"exec cat file",
		"time -p cat file",
		"nice -n 5 cat file",
		"nohup cat file",
		"timeout 5 cat file",
		"/usr/bin/cat file",
		"\\cat file",
		"bash -c 'cat file'",
		"sh -lc \"cd x && cat file\"",
		"eval 'cat file'",
		"echo $(cat file)",
		"echo `cat file`",
		"diff <(cat a) b",
		"if true; then cat file; fi",
		"for f in a b; do cat $f; done",
		"! cat file",
		"{ cat file; }",
		"(cat file)",
		"rg -l x | xargs cat",
		"cat < file",
		"tail -n +5 file",
		"head -n 401 file",
		"head -n -5 file",
		"sed 's/a/b/' file",
		"sed -n '1,401p' file",
		"awk '{print}' file",
		"less file",
		"more file",
		"bat file",
		"nl file",
		"tac file",
		"git show HEAD:file",
		"git -C repo diff",
		"git diff | cat",
		"git diff | rg foo",
		"git log -p",
	]) {
		assert.equal(unbounded(command), true, command);
	}
	for (const command of [
		"head -n 50 file",
		"head -50 file",
		"head --lines=400 file",
		"head file",
		"tail -n 20 log",
		"head -c 100 file",
		"sed -n '1,400p' file",
		"sed -n '1,10p' src/file.ts | rg needle",
		"sed -n '5p;10,20p' file",
		"sed 50q file",
		"awk 'NR<=20' file",
		"bat -r 1:50 file",
		"cat file | head -n 50",
		"cat -n file | sed -n '1,50p'",
		"cat file | wc -l",
		"git diff --stat",
		"git show --name-only HEAD",
		"git diff | head -n 100",
		"git blame -L 1,20 file",
		"cat file > out.txt",
		"cat a b >> out.txt",
		"cat > out.txt <<'EOF'\ncat secret\nEOF",
		"python - <<EOF\ncat inside heredoc\nEOF",
		"sed -i 's/a/b/' file",
		"echo hi | cat",
		"command -v cat",
		"echo 'cat file'",
		"npm test",
		"",
	]) {
		assert.equal(unbounded(command), false, command);
	}
});

test("evaluate: a search in the same Bash command does not mask its own read", () => {
	const result = evaluate(bash("cat big.txt | rg needle"), null, "deny");
	assert.equal(result.output.hookSpecificOutput.permissionDecision, "deny");
	assert.equal(result.state, null, "a blocked command must not record a search");
});

test("evaluate: state from an earlier turn id is discarded", () => {
	const stored = { turn: "t1", allowFull: true, searchUsed: true };
	assert.deepEqual(currentState(stored, { prompt_id: "t2" }), { turn: "t2", allowFull: false, searchUsed: false });
	assert.deepEqual(currentState(stored, { prompt_id: "t1" }), stored);
	assert.deepEqual(currentState({ nonsense: 1 }, {}), { turn: null, allowFull: false, searchUsed: false });
});

test("evaluate: off mode is a no-op", () => {
	assert.deepEqual(evaluate(read(), null, "off"), { state: null, output: null });
	assert.deepEqual(evaluate(bash("cat x"), null, "off"), { state: null, output: null });
	assert.deepEqual(evaluate(tool("Grep", { pattern: "x" }), null, "off"), { state: null, output: null });
});

// ---------------------------------------------------------------------------
// end to end: spawn the hook with JSON on stdin
// ---------------------------------------------------------------------------

test("unbounded Read warns by default with PreToolUse additionalContext", () => {
	const data = newData();
	assert.equal(run(prompt(), {}, data).output, null);
	const result = run(read(), {}, data);
	assert.equal(result.output.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(decision(result), undefined);
	assert.match(context(result), /Grep\/Glob/);
	assert.match(context(result), /\/repo\/x\.txt/);
});

test("unbounded Read denies in deny mode and asks in ask mode", () => {
	const data = newData();
	run(prompt(), {}, data);
	const denied = run(read(), { READ_POLICY_MODE: "deny" }, data);
	assert.equal(decision(denied), "deny");
	assert.match(denied.output.hookSpecificOutput.permissionDecisionReason, /limit <= 400/);
	const asked = run(read(), { READ_POLICY_MODE: "ask" }, data);
	assert.equal(decision(asked), "ask");
});

test("bounded Read is allowed silently", () => {
	const data = newData();
	run(prompt(), {}, data);
	assert.equal(run(read({ limit: 400 }), { READ_POLICY_MODE: "deny" }, data).output, null);
	assert.equal(run(read({ offset: 100, limit: 50 }), { READ_POLICY_MODE: "deny" }, data).output, null);
	assert.equal(decision(run(read({ limit: 401 }), { READ_POLICY_MODE: "deny" }, data)), "deny");
});

test("Read after Grep or Glob in the same prompt is allowed", () => {
	for (const search of [tool("Grep", { pattern: "needle", path: "." }), tool("Glob", { pattern: "**/*.ts" })]) {
		const data = newData();
		run(prompt(), {}, data);
		assert.equal(run(search, { READ_POLICY_MODE: "deny" }, data).output, null);
		assert.equal(run(read(), { READ_POLICY_MODE: "deny" }, data).output, null);
	}
});

test("a new UserPromptSubmit resets per-prompt state", () => {
	const data = newData();
	run(prompt(), {}, data);
	run(tool("Grep", { pattern: "x" }), {}, data);
	assert.equal(run(read(), { READ_POLICY_MODE: "deny" }, data).output, null);
	run(prompt("now look at something else"), {}, data);
	assert.equal(decision(run(read(), { READ_POLICY_MODE: "deny" }, data)), "deny");
});

test("explicit full-file request allows unbounded reads until the next prompt", () => {
	const data = newData();
	run(prompt("read the entire file"), {}, data);
	assert.equal(run(read(), { READ_POLICY_MODE: "deny" }, data).output, null);
	assert.equal(run(bash("cat src/file.ts"), { READ_POLICY_MODE: "deny" }, data).output, null);
	run(prompt("thanks, next task"), {}, data);
	assert.equal(decision(run(read(), { READ_POLICY_MODE: "deny" }, data)), "deny");
});

test("Bash cat is flagged; Bash rg counts as a search", () => {
	const data = newData();
	run(prompt(), {}, data);
	assert.equal(decision(run(bash("cat src/file.ts"), { READ_POLICY_MODE: "deny" }, data)), "deny");
	assert.match(context(run(bash("cat src/file.ts"), {}, data)), /unbounded read \(cat\)/);
	assert.equal(run(bash("rg -n needle src"), { READ_POLICY_MODE: "deny" }, data).output, null);
	assert.equal(run(bash("cat src/file.ts"), { READ_POLICY_MODE: "deny" }, data).output, null);
	assert.equal(run(read(), { READ_POLICY_MODE: "deny" }, data).output, null);
});

test("compound Bash reads cannot be masked by a search or another bounded segment", () => {
	for (const command of ["cat big.txt | rg needle", "rg needle src; cat src/other.ts", "rg x && cat y", "head -n 5 a || cat b"]) {
		const data = newData();
		run(prompt(), {}, data);
		assert.equal(decision(run(bash(command), { READ_POLICY_MODE: "deny" }, data)), "deny", command);
		// The blocked command did not record its search segment.
		assert.equal(decision(run(read(), { READ_POLICY_MODE: "deny" }, data)), "deny", command);
	}
	assert.equal(run(bash("sed -n '1,10p' src/file.ts | rg needle"), { READ_POLICY_MODE: "deny" }).output, null);
});

test("bounded shell reads pass", () => {
	for (const command of ["head -n 50 file", "sed -n '1,400p' src/file.ts", "tail -n 20 log.txt", "cat file | head -n 50", "git diff --stat"]) {
		assert.equal(run(bash(command), { READ_POLICY_MODE: "deny" }).output, null, command);
	}
});

test("leading env assignments and wrappers do not hide a read", () => {
	for (const command of ["FOO=1 cat file", "sudo cat file", "sudo -u root cat file", "env LANG=C cat file", "bash -c 'cat file'", "time cat file"]) {
		assert.equal(decision(run(bash(command), { READ_POLICY_MODE: "deny" })), "deny", command);
	}
});

test("off mode and READ_POLICY_DISABLED are no-ops and write no state", () => {
	for (const env of [{ READ_POLICY_MODE: "off" }, { READ_POLICY_DISABLED: "1", READ_POLICY_MODE: "deny" }]) {
		const data = newData();
		assert.equal(run(prompt(), env, data).output, null);
		assert.equal(run(read(), env, data).output, null);
		assert.equal(run(bash("cat file"), env, data).output, null);
		assert.deepEqual(readdirSync(data), []);
	}
});

test("malformed stdin fails open with a bounded diagnostic", () => {
	for (const stdin of ["not-json", "null", "[1", ""]) {
		const result = spawnHook(stdin, { READ_POLICY_MODE: "deny" });
		assert.equal(result.status, 0, stdin);
		assert.doesNotMatch(result.stdout, /deny/, stdin);
	}
	const result = spawnHook("not-json", { READ_POLICY_MODE: "deny" });
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^read-policy: invalid input; proceeding\n$/);
});

test("unexpected input shapes fail open", () => {
	for (const input of [{}, { hook_event_name: "PreToolUse" }, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: 42 } }, { hook_event_name: "Stop" }]) {
		const result = run(input, { READ_POLICY_MODE: "deny" });
		assert.equal(decision(result), undefined, JSON.stringify(input));
	}
});

test("separate session_ids do not share state", () => {
	const data = newData();
	run(prompt("inspect", "a"), {}, data);
	run(prompt("inspect", "b"), {}, data);
	run(tool("Grep", { pattern: "x" }, "a"), {}, data);
	assert.equal(run(read({}, "a"), { READ_POLICY_MODE: "deny" }, data).output, null);
	assert.equal(decision(run(read({}, "b"), { READ_POLICY_MODE: "deny" }, data)), "deny");
});

test("state dir is 0700, state files are 0600, and filenames do not leak session ids", () => {
	const data = newData();
	run(prompt("inspect", "../../etc/evil"), {}, data);
	run(tool("Grep", { pattern: "x" }, "../../etc/evil"), {}, data);
	const dir = join(data, "read-policy");
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	const files = readdirSync(dir);
	assert.equal(files.length, 1);
	assert.match(files[0], /^session-[0-9a-f]{32}\.json$/);
	assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]), "utf8")), { turn: null, allowFull: false, searchUsed: true });
});

test("importing the module does not run the hook", async () => {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(hook)}); console.log("imported")`], {
		input: JSON.stringify(read()),
		encoding: "utf8",
		env: { ...CLEAN_ENV, CLAUDE_PLUGIN_DATA: newData(), READ_POLICY_MODE: "deny" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "imported\n");
});
