#!/usr/bin/env node

/**
 * Session Policy Hook
 *
 * Injects the plugin's session policy (policy/session-policy.md) as
 * SessionStart additionalContext, so the defaults apply in every repository,
 * including ones with no CLAUDE.md or AGENTS.md.
 *
 * Registered for SessionStart (startup|resume|clear|compact). The policy file
 * is resolved relative to this script, so it works from an installed plugin
 * and from a checkout alike.
 *
 *   SESSION_POLICY_DISABLED=1 — emit nothing
 *
 * Fails open: a missing or unreadable policy file, or any internal error,
 * emits nothing on stdout and one line on stderr.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_POLICY_CHARS = 8000;

export const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "policy", "session-policy.md");

export function isDisabled(env = process.env) {
	return env.SESSION_POLICY_DISABLED === "1";
}

/** Trim and bound the policy text; returns "" for empty input. */
export function boundPolicy(text, max = MAX_POLICY_CHARS) {
	const trimmed = String(text ?? "").trim();
	if (trimmed.length <= max) return trimmed;
	const marker = "\n\n[session policy truncated]";
	return trimmed.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Pure: build the SessionStart output for a policy text (null = emit nothing). */
export function buildOutput(text) {
	const context = boundPolicy(text);
	if (!context) return null;
	return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
}

function diagnostic(code) {
	try {
		process.stderr.write(`session-policy: ${code}; proceeding\n`);
	} catch {
		/* best effort */
	}
}

export function main({ env = process.env, policyPath = POLICY_PATH } = {}) {
	try {
		if (isDisabled(env)) return;
		let text;
		try {
			text = readFileSync(policyPath, "utf8");
		} catch {
			diagnostic("policy file unreadable");
			return;
		}
		const output = buildOutput(text);
		if (output) process.stdout.write(JSON.stringify(output));
	} catch {
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
