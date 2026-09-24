#!/usr/bin/env node

/**
 * Read Policy Hook
 *
 * Claude Code port of the Pi `read-policy` extension (shell handling ported
 * from the Codex version). Keeps context smaller by nudging toward a
 * search-first, paginated-read strategy:
 *
 *  - Prefer Grep/Glob (or a Bash search such as rg/grep/find/fd/ls/tree/
 *    git grep/git ls-files) to locate what matters before reading.
 *  - Then read with a bound: Read with `limit` <= 400, or a bounded shell read
 *    (head/tail -n N, sed -n 'A,Bp', awk 'NR<=N', bat -r A:B, or any unbounded
 *    read piped into such a limiter or redirected to a file).
 *  - Allow an unbounded read only when a search ran earlier in the same prompt,
 *    or when the user explicitly asked to read the entire/full/whole file.
 *
 * This is a context-hygiene nudge, NOT a security boundary. The shell analysis
 * below is a small best-effort tokenizer, not a shell parser: variables,
 * aliases, functions, scripts, and exotic syntax are not resolved, and anyone
 * who wants to read a file unbounded can trivially do so. It only aims to catch
 * the common shapes an agent actually emits (including leading env
 * assignments, sudo/env/command/exec/time/nice/nohup/timeout/xargs wrappers,
 * shell keywords, `bash -c '...'`, and command substitutions).
 *
 * A PreToolUse hook here does not rewrite tool inputs, so an unbounded
 * pre-search read is handled per `READ_POLICY_MODE`:
 *   warn (default) — allow, but inject a reminder to paginate
 *   deny           — block with a reason so Claude retries bounded or searches first
 *   ask            — surface a permission prompt to the human
 *   off            — disable the policy entirely (also: READ_POLICY_DISABLED=1)
 *
 * Registered for UserPromptSubmit (resets per-prompt state) and PreToolUse on
 * Bash/Read/Grep/Glob. Fails open: any internal error lets the tool proceed.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_READ_LIMIT = 400;
/** Byte budget for `head -c N` / `tail -c N` (roughly MAX_READ_LIMIT lines of 100 chars). */
export const MAX_READ_BYTES = 40_000;
const MODES = new Set(["warn", "deny", "ask", "off"]);
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Prompt phrasings that count as the user explicitly asking for a whole file. */
export const FULL_FILE_REQUEST_PATTERNS = [
	/\b(?:read|open|inspect|show|view|print|cat|dump|load)\s+(?:me\s+)?(?:the\s+|this\s+|that\s+)?(?:entire|full|whole|complete)\s+(?:contents?|files?|source)/i,
	/\b(?:entire|full|whole|complete)\s+(?:file|files|file\s+contents?|contents?\s+of)\b/i,
	/\ball\s+(?:of\s+)?(?:the\s+|its\s+)?contents\b/i,
	/\bin\s+(?:its|their)\s+entirety\b/i,
	/\b(?:read|open|inspect|show|view|print|dump)\s+(?:\S+\s+){0,3}in\s+full\b/i,
	/\bevery\s+line\b/i,
];

export function isFullFileRequest(prompt) {
	const text = String(prompt ?? "");
	return FULL_FILE_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

export function readMode(env = process.env) {
	if (env.READ_POLICY_DISABLED === "1") return "off";
	const mode = String(env.READ_POLICY_MODE || "warn").trim().toLowerCase();
	return MODES.has(mode) ? mode : "warn";
}

// ---------------------------------------------------------------------------
// Structured Read tool
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif)$/i;

export function isBoundedRead(toolInput = {}) {
	const limit = toolInput.limit;
	if (typeof limit === "number" && Number.isFinite(limit) && limit > 0 && limit <= MAX_READ_LIMIT) return true;
	const filePath = String(toolInput.file_path ?? "");
	// Images are returned as a single attachment, and PDFs with `pages` are
	// already paginated; neither is a line-oriented full-file dump.
	if (BINARY_EXTENSIONS.test(filePath)) return true;
	if (/\.pdf$/i.test(filePath) && typeof toolInput.pages === "string" && toolInput.pages.trim()) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Shell analysis (best effort; see header comment)
// ---------------------------------------------------------------------------

const OPERATORS = ["&>>", "<<<", "<<-", "&&", "||", ";;", "|&", "&>", ">>", ">|", ">&", "<&", "<>", "<<", "<", ">", "|", "&", ";", "(", ")"];
const LIST_SEPARATORS = new Set(["\n", ";", ";;", "&", "&&", "||", "(", ")"]);
const PIPE_OPERATORS = new Set(["|", "|&"]);
const REDIRECT_OPERATORS = new Set(["&>>", "<<<", "<<-", "&>", ">>", ">|", ">&", "<&", "<>", "<<", "<", ">"]);

function scanBalanced(src, start) {
	// src[start] is "(". Returns the inner text and the index after the match.
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") {
			i++;
		} else if (c === "'") {
			const close = src.indexOf("'", i + 1);
			i = close === -1 ? src.length : close;
		} else if (c === '"') {
			i++;
			while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
		} else if (c === "(") {
			depth++;
		} else if (c === ")") {
			depth--;
			if (depth === 0) return { inner: src.slice(start + 1, i), end: i + 1 };
		}
	}
	return { inner: src.slice(start + 1), end: src.length };
}

function scanBacktick(src, start) {
	let i = start + 1;
	while (i < src.length && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
	return { inner: src.slice(start + 1, i), end: Math.min(i + 1, src.length) };
}

/**
 * Tokenize a shell command into words and operators. Command and process
 * substitutions are pulled out into `subs` (analysed as separate commands) and
 * heredoc bodies are skipped.
 */
export function tokenize(src) {
	const tokens = [];
	const subs = [];
	const pendingHeredocs = [];
	let word = "";
	let started = false;
	let expectDelimiter = null;

	const pushWord = () => {
		if (!started) return;
		tokens.push({ type: "word", value: word });
		if (expectDelimiter) {
			pendingHeredocs.push({ delimiter: word, dash: expectDelimiter === "<<-" });
			expectDelimiter = null;
		}
		word = "";
		started = false;
	};

	const substitution = (i) => {
		// Handles $( ... ), $(( ... )) and <( ... ) / >( ... ) starting at i.
		const open = src[i + 1] === "(" ? i + 1 : i;
		const { inner, end } = scanBalanced(src, open);
		if (!inner.startsWith("(")) subs.push(inner); // $(( )) is arithmetic, not a command
		word += "_";
		started = true;
		return end;
	};

	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "\\") {
			if (next === "\n") {
				i += 2;
				continue;
			}
			word += next ?? "";
			started = true;
			i += 2;
		} else if (c === "'") {
			const close = src.indexOf("'", i + 1);
			const end = close === -1 ? src.length : close;
			word += src.slice(i + 1, end);
			started = true;
			i = end + 1;
		} else if (c === '"') {
			started = true;
			i++;
			while (i < src.length && src[i] !== '"') {
				if (src[i] === "\\" && i + 1 < src.length) {
					word += src[i + 1];
					i += 2;
				} else if (src[i] === "$" && src[i + 1] === "(") {
					i = substitution(i);
				} else if (src[i] === "`") {
					const { inner, end } = scanBacktick(src, i);
					subs.push(inner);
					word += "_";
					i = end;
				} else {
					word += src[i];
					i++;
				}
			}
			i++;
		} else if (c === "`") {
			const { inner, end } = scanBacktick(src, i);
			subs.push(inner);
			word += "_";
			started = true;
			i = end;
		} else if (c === "$" && next === "(") {
			i = substitution(i);
		} else if ((c === "<" || c === ">") && next === "(" && !started) {
			i = substitution(i);
		} else if (c === "#" && !started) {
			while (i < src.length && src[i] !== "\n") i++;
		} else if (c === " " || c === "\t" || c === "\r") {
			pushWord();
			i++;
		} else if (c === "\n") {
			pushWord();
			tokens.push({ type: "op", value: "\n" });
			i++;
			for (const heredoc of pendingHeredocs.splice(0)) {
				while (i < src.length) {
					let lineEnd = src.indexOf("\n", i);
					if (lineEnd === -1) lineEnd = src.length;
					let line = src.slice(i, lineEnd);
					if (heredoc.dash) line = line.replace(/^\t+/, "");
					i = lineEnd + 1;
					if (line === heredoc.delimiter) break;
				}
			}
		} else if (";&|()<>".includes(c)) {
			let fd;
			if (started && (c === "<" || c === ">") && /^\d+$/.test(word)) {
				fd = word;
				word = "";
				started = false;
			}
			pushWord();
			const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
			tokens.push({ type: "op", value: op, fd });
			if (op === "<<" || op === "<<-") expectDelimiter = op;
			i += op.length;
		} else {
			word += c;
			started = true;
			i++;
		}
	}
	pushWord();
	return { tokens, subs };
}

/** Group tokens into pipelines of stages: [[{ words, redirects }]]. */
export function pipelines(tokens) {
	const result = [];
	let stages = [];
	let stage = { words: [], redirects: [] };
	const endStage = () => {
		if (stage.words.length || stage.redirects.length) stages.push(stage);
		stage = { words: [], redirects: [] };
	};
	const endPipeline = () => {
		endStage();
		if (stages.length) result.push(stages);
		stages = [];
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === "word") {
			stage.words.push(token.value);
		} else if (LIST_SEPARATORS.has(token.value)) {
			endPipeline();
		} else if (PIPE_OPERATORS.has(token.value)) {
			endStage();
		} else if (REDIRECT_OPERATORS.has(token.value)) {
			const target = tokens[i + 1]?.type === "word" ? tokens[++i].value : "";
			stage.redirects.push({ op: token.value, fd: token.fd, target });
		}
	}
	endPipeline();
	return result;
}

/**
 * Walk option tokens. `valued` lists options that take a separate value.
 * Returns { options: [[name, value]], operands, rest } where `rest` is the index
 * of the first operand when `stopAtOperand` is set.
 */
function parseOptions(args, valued = [], { stopAtOperand = false } = {}) {
	const valuedSet = new Set(valued);
	const options = [];
	const operands = [];
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			i++;
			if (!stopAtOperand) operands.push(...args.slice(i));
			return { options, operands, rest: i };
		}
		if (arg.startsWith("--") && arg.length > 2) {
			const eq = arg.indexOf("=");
			if (eq !== -1) options.push([arg.slice(0, eq), arg.slice(eq + 1)]);
			else if (valuedSet.has(arg)) options.push([arg, args[++i] ?? ""]);
			else options.push([arg, true]);
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				const name = `-${arg[j]}`;
				if (valuedSet.has(name)) {
					const attached = arg.slice(j + 1);
					options.push([name, attached || (args[++i] ?? "")]);
					break;
				}
				options.push([name, true]);
			}
			if (/^-\d+$/.test(arg)) options.push(["-NUM", arg.slice(1)]);
		} else if (stopAtOperand) {
			return { options, operands, rest: i };
		} else {
			operands.push(arg);
		}
	}
	return { options, operands, rest: i };
}

const has = (options, ...names) => options.some(([name]) => names.includes(name));
const valueOf = (options, ...names) => {
	const found = options.filter(([name]) => names.includes(name)).pop();
	return found ? found[1] : undefined;
};

/** Per-wrapper option tables: options that take a separate value. */
const WRAPPERS = {
	command: [],
	builtin: [],
	exec: ["-a"],
	nohup: [],
	sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--close-from"],
	doas: ["-u", "-C"],
	env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
	time: ["-f", "-o", "--format", "--output"],
	nice: ["-n", "--adjustment"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
	xargs: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"],
};
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const HEADER_KEYWORDS = new Set(["for", "select", "case", "esac", "function", "in"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/**
 * Strip assignments, keywords, and wrappers from a stage's words.
 * Returns { argv, nested: string[], viaXargs } or null when it is not a command.
 */
export function unwrap(words) {
	let argv = [...words];
	const nested = [];
	let viaXargs = false;
	for (let guard = 0; guard < 32 && argv.length; guard++) {
		const [first] = argv;
		if (ASSIGNMENT.test(first)) {
			argv = argv.slice(1);
			continue;
		}
		if (KEYWORDS.has(first)) {
			argv = argv.slice(1);
			continue;
		}
		if (HEADER_KEYWORDS.has(first)) return null;
		const program = basename(first);
		if (Object.hasOwn(WRAPPERS, program)) {
			const args = argv.slice(1);
			const { options, rest } = parseOptions(args, WRAPPERS[program], { stopAtOperand: true });
			if (program === "command" && has(options, "-v", "-V")) return null; // lookup only
			if (program === "env") {
				const split = valueOf(options, "-S", "--split-string");
				if (typeof split === "string") nested.push(split);
			}
			if (program === "xargs") viaXargs = true;
			let remaining = args.slice(rest);
			if (program === "timeout") remaining = remaining.slice(1); // DURATION
			argv = remaining;
			continue;
		}
		break;
	}
	if (!argv.length) return nested.length ? { argv, nested, viaXargs } : null;
	const program = basename(argv[0]);
	if (SHELLS.has(program)) {
		for (let i = 1; i < argv.length; i++) {
			const arg = argv[i];
			if (arg === "-o" || arg === "+o") {
				i++;
			} else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
				if (argv[i + 1] !== undefined) nested.push(argv[i + 1]);
				break;
			} else if (!/^[-+]/.test(arg)) {
				break;
			}
		}
	} else if (program === "eval") {
		nested.push(argv.slice(1).join(" "));
	}
	return { argv, nested, viaXargs };
}

const SEARCH_PROGRAMS = new Set(["rg", "ripgrep", "grep", "egrep", "fgrep", "find", "fd", "fdfind", "ls", "tree", "ag", "ack"]);
const PLAIN_READERS = new Set(["cat", "tac", "less", "more"]);
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
const GIT_SUMMARY_FLAGS = ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--dirstat", "--raw", "--quiet", "-s", "--no-patch"];

function positiveInt(value) {
	return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
}

function headTailBounded(options) {
	const bytes = valueOf(options, "-c", "--bytes");
	const lines = valueOf(options, "-n", "--lines") ?? valueOf(options, "-NUM");
	if (lines === undefined && bytes !== undefined) {
		const n = positiveInt(bytes);
		return n !== undefined && n <= MAX_READ_BYTES;
	}
	if (lines === undefined) return true; // default is 10 lines
	// `tail -n +N` (from line N) and `head -n -N` (all but N) are unbounded.
	const n = positiveInt(lines);
	return n !== undefined && n <= MAX_READ_LIMIT;
}

function sedScriptLines(script, quiet) {
	let total = 0;
	for (const raw of script.split(/[;\n]/)) {
		const command = raw.trim();
		if (!command) continue;
		let match = command.match(/^(\d+)\s*q$/);
		if (match) {
			if (!quiet) total += Number(match[1]);
			continue;
		}
		if (!quiet) return Infinity;
		if (/^\$\s*p$/.test(command)) {
			total += 1;
			continue;
		}
		match = command.match(/^(\d+)\s*(?:,\s*(\d+))?\s*p$/);
		if (!match) return Infinity;
		const start = Number(match[1]);
		const end = match[2] === undefined ? start : Number(match[2]);
		total += Math.max(1, end - start + 1);
	}
	return total;
}

function awkBounded(program) {
	const upper = program.match(/\bF?NR\s*(<=|<|==)\s*(\d+)/);
	if (upper) return Number(upper[2]) - (upper[1] === "<" ? 1 : 0) <= MAX_READ_LIMIT;
	const exit = program.match(/\bF?NR\s*>=?\s*(\d+)\s*\{\s*exit\b/);
	return Boolean(exit && Number(exit[1]) <= MAX_READ_LIMIT);
}

function batBounded(range) {
	if (typeof range !== "string") return false;
	let match = range.match(/^(\d+)?:(\d+)$/);
	if (match) return Number(match[2]) - Number(match[1] ?? 1) + 1 <= MAX_READ_LIMIT;
	match = range.match(/^(\d+):\+(\d+)$/);
	if (match) return Number(match[2]) + 1 <= MAX_READ_LIMIT;
	return /^\d+$/.test(range);
}

const realFiles = (operands) => operands.filter((operand) => operand !== "-");

/**
 * Classify one unwrapped command.
 * Returns { search, limiter, read: null | { bounded, readsFiles, always }, label }.
 */
export function classifyCommand(argv) {
	const result = { search: false, limiter: false, read: null, label: "" };
	if (!argv.length) return result;
	const program = basename(argv[0]);
	const args = argv.slice(1);
	result.label = program;

	if (SEARCH_PROGRAMS.has(program)) {
		result.search = true;
		return result;
	}
	if (program === "wc") {
		result.limiter = true;
		return result;
	}
	if (PLAIN_READERS.has(program) || program === "nl") {
		const { operands } = parseOptions(args, program === "nl" ? ["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"] : []);
		result.read = { bounded: false, readsFiles: realFiles(operands).length > 0, always: false };
		return result;
	}
	if (program === "head" || program === "tail") {
		const { options, operands } = parseOptions(args, ["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"]);
		const bounded = headTailBounded(options);
		result.limiter = bounded;
		result.read = { bounded, readsFiles: realFiles(operands).length > 0, always: false };
		return result;
	}
	if (program === "sed") {
		const { options, operands } = parseOptions(args, ["-e", "-f", "-l", "--expression", "--file", "--line-length"]);
		if (has(options, "-i", "--in-place")) return result; // edits in place, prints nothing
		const scripts = options.filter(([name]) => name === "-e" || name === "--expression").map(([, value]) => String(value));
		const files = [...operands];
		if (!scripts.length && !has(options, "-f", "--file") && files.length) scripts.push(files.shift());
		const quiet = has(options, "-n", "--quiet", "--silent");
		const bounded = scripts.length > 0 && !has(options, "-f", "--file") && scripts.reduce((sum, script) => sum + sedScriptLines(script, quiet), 0) <= MAX_READ_LIMIT;
		result.limiter = bounded;
		result.read = { bounded, readsFiles: realFiles(files).length > 0, always: false };
		return result;
	}
	if (AWKS.has(program)) {
		const { options, operands } = parseOptions(args, ["-F", "-v", "-f", "-e", "-W", "--field-separator", "--assign", "--file", "--source"]);
		const files = [...operands];
		const programs = options.filter(([name]) => name === "-e" || name === "--source").map(([, value]) => String(value));
		if (!programs.length && !has(options, "-f", "--file") && files.length) programs.push(files.shift());
		const bounded = programs.some(awkBounded);
		result.limiter = bounded;
		result.read = { bounded, readsFiles: realFiles(files).length > 0, always: false };
		return result;
	}
	if (program === "bat" || program === "batcat") {
		const { options, operands } = parseOptions(args, ["-l", "--language", "-H", "--highlight-line", "-r", "--line-range", "--style", "--theme", "--tabs", "--wrap", "--terminal-width", "-m", "--map-syntax", "--color", "--italic-text", "--decorations", "--paging", "--pager", "--file-name", "--diff-context"]);
		const ranges = options.filter(([name]) => name === "-r" || name === "--line-range");
		const bounded = ranges.length > 0 && ranges.every(([, range]) => batBounded(range));
		result.read = { bounded, readsFiles: realFiles(operands).length > 0, always: false };
		return result;
	}
	if (program === "git") {
		const { rest } = parseOptions(args, ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"], { stopAtOperand: true });
		const subcommand = args[rest];
		const subArgs = args.slice(rest + 1);
		result.label = `git ${subcommand ?? ""}`.trim();
		if (subcommand === "grep" || subcommand === "ls-files" || subcommand === "ls-tree") {
			result.search = true;
			return result;
		}
		const isLogPatch = subcommand === "log" && subArgs.some((arg) => arg === "-p" || arg === "-u" || arg === "--patch");
		if (subcommand === "show" || subcommand === "diff" || subcommand === "blame" || isLogPatch) {
			let bounded = subArgs.some((arg) => GIT_SUMMARY_FLAGS.includes(arg));
			if (subcommand === "blame") {
				const { options } = parseOptions(subArgs, ["-L"]);
				const range = String(valueOf(options, "-L") ?? "").match(/^(\d+),(\d+)$/);
				bounded = Boolean(range && Number(range[2]) - Number(range[1]) + 1 <= MAX_READ_LIMIT);
			}
			result.read = { bounded, readsFiles: true, always: true };
		}
		return result;
	}
	return result;
}

const STDOUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const TERMINAL_TARGETS = new Set(["/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/1", "/dev/fd/2"]);

function redirectsStdoutToFile(stage) {
	return stage.redirects.some(
		(redirect) =>
			STDOUT_REDIRECTS.has(redirect.op) &&
			(redirect.fd === undefined || redirect.fd === "1") &&
			redirect.target &&
			!TERMINAL_TARGETS.has(redirect.target),
	);
}

function readsStdinFromFile(stage) {
	return stage.redirects.some(
		(redirect) => (redirect.op === "<" || redirect.op === "<>") && (redirect.fd === undefined || redirect.fd === "0") && redirect.target && redirect.target !== "/dev/null",
	);
}

/**
 * Analyse a Bash command string.
 * Returns { search: boolean, unboundedReads: string[] }.
 *
 * A pipeline stage is an unbounded read when it reads file contents (file
 * operands, `< file`, fed by xargs, or git show/diff/blame) without its own
 * bound, and no later stage limits the output (head/tail -n N, sed -n range,
 * awk NR bound, wc) and the output is not redirected to a file. So
 * `cat big | rg needle` is still unbounded, while `cat big | head -n 50` is not.
 */
export function analyzeShellCommand(command, depth = 0) {
	const analysis = { search: false, unboundedReads: [] };
	if (typeof command !== "string" || !command.trim() || depth > 8) return analysis;
	const { tokens, subs } = tokenize(command);
	const merge = (inner) => {
		analysis.search ||= inner.search;
		analysis.unboundedReads.push(...inner.unboundedReads);
	};
	for (const sub of subs) merge(analyzeShellCommand(sub, depth + 1));

	for (const stages of pipelines(tokens)) {
		const infos = stages.map((stage) => {
			const unwrapped = unwrap(stage.words);
			if (!unwrapped) return { stage, info: classifyCommand([]), viaXargs: false };
			for (const nested of unwrapped.nested) merge(analyzeShellCommand(nested, depth + 1));
			return { stage, info: classifyCommand(unwrapped.argv), viaXargs: unwrapped.viaXargs };
		});
		const lastRedirected = redirectsStdoutToFile(stages[stages.length - 1]);
		infos.forEach(({ stage, info, viaXargs }, index) => {
			if (info.search) analysis.search = true;
			const read = info.read;
			if (!read || read.bounded) return;
			const readsFile = read.always || read.readsFiles || viaXargs || readsStdinFromFile(stage);
			if (!readsFile) return;
			if (lastRedirected || redirectsStdoutToFile(stage)) return;
			if (infos.slice(index + 1).some((later) => later.info.limiter)) return;
			analysis.unboundedReads.push(info.label);
		});
	}
	return analysis;
}

// ---------------------------------------------------------------------------
// Decision logic (pure)
// ---------------------------------------------------------------------------

export function freshState(turn = null) {
	return { turn, allowFull: false, searchUsed: false };
}

export function turnId(input) {
	const value = input.prompt_id ?? input.promptId ?? input.turn_id ?? input.turnId ?? null;
	return value === null || value === undefined ? null : String(value);
}

/** Current-turn state: stored state only if it belongs to this turn. */
export function currentState(stored, input) {
	const turn = turnId(input);
	if (stored && typeof stored.allowFull === "boolean" && typeof stored.searchUsed === "boolean" && (stored.turn ?? null) === turn) {
		return { turn, allowFull: stored.allowFull, searchUsed: stored.searchUsed };
	}
	// No state yet, or a new prompt whose UserPromptSubmit hook did not run:
	// start fresh. We cannot recover the prompt text here, so allowFull is false.
	return freshState(turn);
}

function readReason(filePath) {
	return (
		`Read-policy: this is an unbounded full-file read of ${filePath} with no prior search in this turn. ` +
		`Prefer to locate what matters first with Grep/Glob (a search unlocks unbounded reads for the rest of the turn), ` +
		`or pass a bounded 'offset'/'limit' (limit <= ${MAX_READ_LIMIT}). ` +
		`If you truly need the whole file, the user can ask to "read the full file", or set READ_POLICY_MODE=off.`
	);
}

function bashReason(labels) {
	const what = [...new Set(labels)].join(", ");
	return (
		`Read-policy: this Bash command runs an unbounded read (${what}) with no prior search in this turn. ` +
		`Prefer to locate what matters first with Grep/Glob or a shell search (rg, grep, find, fd, git grep), ` +
		`or bound the read (head -n N, sed -n 'A,Bp', N <= ${MAX_READ_LIMIT}; or pipe it through such a limiter). ` +
		`Piping into a search (e.g. \`cat file | rg x\`) does not count. ` +
		`If you truly need the whole file, the user can ask to "read the full file", or set READ_POLICY_MODE=off.`
	);
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

/**
 * Pure decision function.
 * @param input  Claude Code hook input (hook_event_name, tool_name, tool_input, prompt, ...)
 * @param stored previously stored state for this session (or null)
 * @param mode   warn | deny | ask | off
 * @returns { state: object | null (null = do not write), output: object | null (null = silent allow) }
 */
export function evaluate(input, stored, mode) {
	if (mode === "off") return { state: null, output: null };
	const event = input.hook_event_name ?? input.event;

	if (event === "UserPromptSubmit") {
		const prompt = input.prompt ?? input.prompt_text ?? input.user_prompt ?? "";
		return { state: { turn: turnId(input), allowFull: isFullFileRequest(prompt), searchUsed: false }, output: null };
	}
	if (event !== "PreToolUse") return { state: null, output: null };

	const tool = String(input.tool_name ?? "").toLowerCase();
	const toolInput = input.tool_input ?? {};
	const state = currentState(stored, input);

	// Search tools unlock unbounded reads for the rest of this prompt.
	if (tool === "grep" || tool === "glob") {
		return { state: { ...state, searchUsed: true }, output: null };
	}

	if (tool === "bash") {
		const analysis = analyzeShellCommand(typeof toolInput.command === "string" ? toolInput.command : "");
		// Evaluate every segment before recording a search: an unbounded read
		// such as "cat file | rg needle" must not be masked by its own search.
		if (analysis.unboundedReads.length && !state.allowFull && !state.searchUsed) {
			return { state: null, output: violation(mode, bashReason(analysis.unboundedReads)) };
		}
		return { state: analysis.search && !state.searchUsed ? { ...state, searchUsed: true } : null, output: null };
	}

	if (tool !== "read" || state.allowFull || state.searchUsed || isBoundedRead(toolInput)) {
		return { state: null, output: null };
	}
	return { state: null, output: violation(mode, readReason(toolInput.file_path ?? "the file")) };
}

// ---------------------------------------------------------------------------
// I/O (best effort; every failure falls through to "allow")
// ---------------------------------------------------------------------------

function stateDir() {
	const base = process.env.CLAUDE_PLUGIN_DATA
		? join(process.env.CLAUDE_PLUGIN_DATA, "read-policy")
		: join(tmpdir(), `claude-read-policy-${process.getuid?.() ?? "user"}`);
	mkdirSync(base, { recursive: true, mode: 0o700 });
	chmodSync(base, 0o700);
	return base;
}

function statePath(input) {
	const session = String(input.session_id ?? input.sessionId ?? "unknown-session");
	const key = createHash("sha256").update(session).digest("hex").slice(0, 32);
	return join(stateDir(), `session-${key}.json`);
}

function loadState(input) {
	try {
		return JSON.parse(readFileSync(statePath(input), "utf8"));
	} catch {
		return null; // missing or malformed state starts conservatively
	}
}

function saveState(input, state) {
	try {
		const path = statePath(input);
		writeFileSync(path, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
		// writeFileSync({mode}) does not change an existing file's mode.
		chmodSync(path, 0o600);
	} catch {
		/* fail open: state is best-effort */
	}
}

function pruneStaleState() {
	try {
		const dir = stateDir();
		const cutoff = Date.now() - STATE_TTL_MS;
		for (const name of readdirSync(dir)) {
			if (!/^session-[0-9a-f]{32}\.json$/.test(name)) continue;
			const path = join(dir, name);
			if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
		}
	} catch {
		/* best effort */
	}
}

function diagnostic(code) {
	try {
		process.stderr.write(`read-policy: ${code}; proceeding\n`);
	} catch {
		/* never include input, paths, or secrets */
	}
}

export function main() {
	let input;
	try {
		input = JSON.parse(readFileSync(0, "utf8") || "{}");
		if (!input || typeof input !== "object") throw new Error("not an object");
	} catch {
		diagnostic("invalid input");
		return;
	}
	try {
		const mode = readMode();
		if (mode === "off") return;
		const isPrompt = (input.hook_event_name ?? input.event) === "UserPromptSubmit";
		const { state, output } = evaluate(input, isPrompt ? null : loadState(input), mode);
		if (state) saveState(input, state);
		if (isPrompt) pruneStaleState();
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
