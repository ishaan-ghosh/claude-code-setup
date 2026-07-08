#!/usr/bin/env node

/**
 * Read Policy Hook
 *
 * Claude Code port of the Pi `read-policy` extension. Keeps context smaller by
 * nudging toward a search-first, paginated-read strategy:
 *
 *  - Prefer Grep/Glob to locate what matters before reading.
 *  - Then use Read with pagination (`offset`/`limit`) instead of full-file reads.
 *  - Allow an unbounded read only when a search ran earlier in the same prompt,
 *    or when the user explicitly asked to read the entire/full/whole file.
 *
 * Unlike the Pi extension (which could silently cap a read's `limit`), a Claude
 * Code PreToolUse hook cannot rewrite tool inputs. So an unbounded pre-search
 * read is instead handled per `READ_POLICY_MODE`:
 *   warn (default) — allow, but inject a reminder to paginate
 *   deny           — block with a reason so Claude retries bounded or searches first
 *   ask            — surface a permission prompt to the human
 *   off            — disable the policy entirely (also: READ_POLICY_DISABLED=1)
 *
 * Registered for UserPromptSubmit (resets per-prompt state) and PreToolUse on
 * Read/Grep/Glob. Fails open: any internal error lets the tool proceed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_READ_LIMIT = 400;

const FULL_FILE_REQUEST_PATTERN =
	/\b(?:read|open|inspect)\s+(?:the\s+)?(?:entire|full|whole)\s+(?:contents?|file)|\ball\s+contents\b|\bfull\s+file\b/i;

function readMode() {
	if (process.env.READ_POLICY_DISABLED === "1") return "off";
	const mode = (process.env.READ_POLICY_MODE || "warn").trim().toLowerCase();
	return ["deny", "ask", "warn", "off"].includes(mode) ? mode : "warn";
}

function stateDir() {
	const base = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "claude-read-policy");
	mkdirSync(base, { recursive: true });
	return base;
}

function stateFile(sessionId) {
	const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
	return join(stateDir(), `read-policy-${safe}.json`);
}

function loadState(sessionId) {
	try {
		return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
	} catch {
		return null;
	}
}

function saveState(sessionId, state) {
	try {
		writeFileSync(stateFile(sessionId), JSON.stringify(state), "utf8");
	} catch {
		/* fail open: state is best-effort */
	}
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function emit(output) {
	if (output) process.stdout.write(JSON.stringify(output));
	process.exit(0);
}

function proceed() {
	emit({ continue: true });
}

function currentState(sessionId, promptId) {
	const state = loadState(sessionId);
	if (state && state.promptId === promptId) return state;
	// No state yet, or a new prompt whose UserPromptSubmit hook did not run:
	// start fresh. We cannot recover the prompt text here, so allowFull is false.
	return { promptId, allowFull: false, searchUsed: false };
}

function handleUserPromptSubmit(input) {
	const promptText = String(input.prompt_text ?? input.prompt ?? "");
	saveState(input.session_id, {
		promptId: input.prompt_id ?? null,
		allowFull: FULL_FILE_REQUEST_PATTERN.test(promptText),
		searchUsed: false,
	});
	proceed();
}

function handlePreToolUse(input) {
	const toolName = input.tool_name;

	// Search tools unlock unbounded reads for the rest of this prompt.
	if (toolName === "Grep" || toolName === "Glob") {
		const state = currentState(input.session_id, input.prompt_id ?? null);
		state.searchUsed = true;
		saveState(input.session_id, state);
		proceed();
		return;
	}

	if (toolName !== "Read") {
		proceed();
		return;
	}

	if (readMode() === "off") {
		proceed();
		return;
	}

	const state = currentState(input.session_id, input.prompt_id ?? null);
	if (state.allowFull || state.searchUsed) {
		proceed();
		return;
	}

	const limit = input.tool_input?.limit;
	const isBounded = typeof limit === "number" && Number.isFinite(limit) && limit > 0 && limit <= MAX_READ_LIMIT;
	if (isBounded) {
		proceed();
		return;
	}

	const filePath = input.tool_input?.file_path ?? "the file";
	const reason =
		`Read-policy: this is an unbounded full-file read of ${filePath} with no prior search in this turn. ` +
		`Prefer to locate what matters first with Grep/Glob (a search unlocks unbounded reads for the rest of the turn), ` +
		`or pass a bounded 'offset'/'limit' (limit <= ${MAX_READ_LIMIT}). ` +
		`If you truly need the whole file, the user can ask to "read the full file", or set READ_POLICY_MODE=off.`;

	const mode = readMode();
	if (mode === "warn") {
		emit({ continue: true, additionalContext: reason });
		return;
	}

	emit({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: mode === "ask" ? "ask" : "deny",
			permissionDecisionReason: reason,
		},
	});
}

function main() {
	let input;
	try {
		input = JSON.parse(readStdin() || "{}");
	} catch {
		proceed();
		return;
	}

	try {
		if (input.hook_event_name === "UserPromptSubmit") {
			handleUserPromptSubmit(input);
		} else {
			handlePreToolUse(input);
		}
	} catch {
		// Never let a policy error block real work.
		proceed();
	}
}

main();
