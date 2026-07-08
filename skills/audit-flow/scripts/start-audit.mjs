#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_AUDIT_CONFIG_ROOT = fileURLToPath(new URL("../defaults", import.meta.url));

export async function startAudit(options) {
	const normalizedOptions = normalizeAuditRequest(options);
	const projectRoot = resolve(normalizedOptions.projectRoot ?? process.cwd());
	const auditConfigRoot = resolve(projectRoot, normalizedOptions.auditConfigRoot ?? ".claude/audit");
	const profileResolution = await resolveProfilePath(auditConfigRoot, normalizedOptions.profile);
	const profilePath = profileResolution.path;
	const rawProfile = await readFile(profilePath, "utf8");
	let profile = parseYamlSubset(rawProfile);
	profile = applyLocalOverrides(profile, await readLocalOverrides(projectRoot), normalizedOptions.env ?? process.env);
	profile = expandEnvPlaceholders(profile, normalizedOptions.env ?? process.env);

	const profileName = String(profile.name ?? normalizedOptions.profile);
	const auditType = String(profile.type ?? profileName);
	const target = String(normalizedOptions.target ?? "current worktree");
	const auditId = normalizedOptions.auditId ?? makeAuditId(normalizedOptions.now ?? new Date(), auditType, target);
	const artifactRoot = resolveArtifactRoot(projectRoot, profile, normalizedOptions.artifactRoot);
	const auditDir = join(artifactRoot, auditId);
	await ensureArtifactPathSafe(projectRoot, auditDir, normalizedOptions);
	await mkdir(auditDir, { recursive: true });

	const fragments = await readFragments(profileResolution.root, profile.fragments ?? []);
	const git = await readGitMetadata(projectRoot);
	const localOverrides = (await fileExists(join(projectRoot, ".claude/local/audit.overrides.yaml")))
		? [".claude/local/audit.overrides.yaml"]
		: [];

	const artifactNames = {
		auditYml: "audit.yml",
		primaryPrompt: "primary-reviewer-prompt.md",
		primaryInitial: "primary-initial.md",
		primaryFindings: "primary-findings.json",
		peerPrompt: "peer-review-prompt.md",
		peerReview: "peer-review.md",
		findings: "findings.json",
		receipt: "receipt.md",
	};

	const metadata = {
		id: auditId,
		type: auditType,
		status: "in_progress",
		created_at: (normalizedOptions.now ?? new Date()).toISOString(),
		updated_at: (normalizedOptions.now ?? new Date()).toISOString(),
		target: {
			raw: target,
			repo: basename(git?.top_level ?? projectRoot),
			cwd: projectRoot,
			git,
		},
		profile: {
			name: profileName,
			path: relativeFrom(projectRoot, profilePath),
			source: profileResolution.source,
			description: profile.description ?? null,
			fragments: fragments.map((fragment) => fragment.profilePath),
			local_overrides: localOverrides,
			platform: profile.platform ?? null,
			repos: profile.repos ?? null,
		},
		reviewers: {
			primary: {
				role: "primary-reviewer",
				tool: null,
				model: null,
				session_id: null,
				prompt: artifactNames.primaryPrompt,
				artifact: artifactNames.primaryInitial,
				findings: artifactNames.primaryFindings,
			},
			peer: {
				role: "peer-reviewer",
				tool: null,
				model: null,
				session_id: null,
				prompt: artifactNames.peerPrompt,
				artifact: artifactNames.peerReview,
			},
		},
		artifacts: {
			root: auditDir,
			primary_prompt: artifactNames.primaryPrompt,
			primary_initial: artifactNames.primaryInitial,
			primary_findings: artifactNames.primaryFindings,
			peer_review_prompt: artifactNames.peerPrompt,
			peer_review: artifactNames.peerReview,
			findings: artifactNames.findings,
			receipt: artifactNames.receipt,
		},
	};

	const primaryPrompt = buildPrimaryPrompt({ auditId, target, metadata, fragments });
	const peerPrompt = buildPeerPrompt({ auditId, target, metadata, fragments });

	const auditYmlPath = join(auditDir, artifactNames.auditYml);
	const primaryPromptPath = join(auditDir, artifactNames.primaryPrompt);
	const peerPromptPath = join(auditDir, artifactNames.peerPrompt);

	await writeFile(auditYmlPath, toYaml(metadata), "utf8");
	await writeFile(primaryPromptPath, primaryPrompt, "utf8");
	await writeFile(peerPromptPath, peerPrompt, "utf8");

	return {
		auditId,
		auditDir,
		auditYmlPath,
		primaryPromptPath,
		peerPromptPath,
		primaryInitialPath: join(auditDir, artifactNames.primaryInitial),
		primaryFindingsPath: join(auditDir, artifactNames.primaryFindings),
		peerReviewPath: join(auditDir, artifactNames.peerReview),
		findingsPath: join(auditDir, artifactNames.findings),
		receiptPath: join(auditDir, artifactNames.receipt),
	};
}

function normalizeAuditRequest(options) {
	const command = options.profile;
	const aliases = {
		diff: { profile: "commit", target: "diff" },
		staged: { profile: "commit", target: "staged diff" },
		commit: { profile: "commit", target: "commit audit" },
		pr: { profile: "pr", target: "pull request audit" },
		stack: { profile: "pr", target: "stack audit" },
	};

	if (command && aliases[command]) {
		return {
			...options,
			profile: aliases[command].profile,
			target: options.target ?? aliases[command].target,
		};
	}
	return options;
}

async function resolveProfilePath(auditConfigRoot, profile) {
	if (!profile) {
		throw new Error("Missing audit profile. Pass --profile <name> or a positional profile name.");
	}

	const directPath = isAbsolute(profile) ? profile : resolve(process.cwd(), profile);
	if (await fileExists(directPath)) {
		return { path: directPath, root: inferAuditConfigRoot(directPath), source: "direct" };
	}

	const profileFile = profile.endsWith(".yaml") || profile.endsWith(".yml") ? profile : `${profile}.yaml`;
	const repoProfilePath = resolve(auditConfigRoot, "profiles", profileFile);
	if (await fileExists(repoProfilePath)) {
		return { path: repoProfilePath, root: auditConfigRoot, source: "repo" };
	}

	const defaultProfilePath = resolve(DEFAULT_AUDIT_CONFIG_ROOT, "profiles", profileFile);
	if (await fileExists(defaultProfilePath)) {
		return { path: defaultProfilePath, root: DEFAULT_AUDIT_CONFIG_ROOT, source: "default" };
	}

	throw new Error(`Audit profile not found: ${profile} (looked in ${repoProfilePath} and ${defaultProfilePath})`);
}

function inferAuditConfigRoot(profilePath) {
	const parent = dirname(profilePath);
	return basename(parent) === "profiles" ? dirname(parent) : parent;
}

function resolveArtifactRoot(projectRoot, profile, explicitArtifactRoot) {
	if (explicitArtifactRoot) {
		return isAbsolute(explicitArtifactRoot) ? explicitArtifactRoot : resolve(projectRoot, explicitArtifactRoot);
	}

	const artifactBase = resolveArtifactBase(projectRoot, profile);
	const configuredPath = profile.artifact_root?.path;
	if (configuredPath) {
		return isAbsolute(configuredPath) ? configuredPath : resolve(artifactBase, configuredPath);
	}

	return resolve(artifactBase, ".claude/local/audits");
}

function resolveArtifactBase(projectRoot, profile) {
	const artifactRepoName = profile.artifact_root?.repo;
	if (!artifactRepoName) {
		return projectRoot;
	}

	const repo = Array.isArray(profile.repos) ? profile.repos.find((candidate) => candidate.name === artifactRepoName) : null;
	if (!repo) {
		throw new Error(`Profile artifact_root.repo references unknown repo: ${artifactRepoName}`);
	}

	const contextRoot = profile.platform?.context_root;
	const platformRoot = contextRoot ? (isAbsolute(contextRoot) ? contextRoot : resolve(projectRoot, contextRoot)) : projectRoot;
	return isAbsolute(repo.path) ? repo.path : resolve(platformRoot, repo.path);
}

async function readFragments(auditConfigRoot, fragmentPaths) {
	if (!Array.isArray(fragmentPaths)) {
		throw new Error("Profile `fragments` must be a list.");
	}

	const fragments = [];
	for (const fragmentPath of fragmentPaths) {
		const profilePath = String(fragmentPath);
		const absolutePath = isAbsolute(profilePath) ? profilePath : resolve(auditConfigRoot, profilePath);
		const contents = await readFile(absolutePath, "utf8");
		fragments.push({ profilePath, absolutePath, contents });
	}
	return fragments;
}

function buildPrimaryPrompt({ auditId, target, metadata, fragments }) {
	return [
		`# Primary audit prompt`,
		``,
		`You are the primary-reviewer for audit \`${auditId}\`.`,
		``,
		`Target: ${target}`,
		`Audit directory: ${metadata.artifacts.root}`,
		``,
		`Do not edit application code. You may run safe targeted read-only or validation commands when useful. Ask before expensive, stateful, hardware, network-mutating, or destructive commands.`,
		``,
		`Inspect the target directly. Produce findings first, ordered by severity, with exact file/line references for confirmed findings. Distinguish confirmed findings, open questions/assumptions, optional suggestions, and residual risks.`,
		``,
		`If you are running as a delegated reviewer, return the audit report as your final answer so the parent can save it to \`primary-initial.md\`. Include a structured candidate findings section compatible with FINDINGS-SCHEMA.md when practical.`,
		``,
		formatFragments(fragments),
		``,
	].join("\n");
}

function buildPeerPrompt({ auditId, target, metadata, fragments }) {
	return [
		`# Peer-review prompt`,
		``,
		`You are the peer-reviewer for audit \`${auditId}\`.`,
		``,
		`Target: ${target}`,
		`Audit directory: ${metadata.artifacts.root}`,
		`Primary audit artifact to review: ${metadata.artifacts.root}/primary-initial.md`,
		``,
		`Do not edit application code. Review the target directly, then peer-review the primary audit. Confirm valid findings, challenge weak findings, identify missed issues, and call out disagreements with evidence.`,
		``,
		`Return a peer-review report that can be saved as \`peer-review.md\`. Use generic source roles such as primary-reviewer and peer-reviewer; do not depend on specific model names.`,
		``,
		formatFragments(fragments),
		``,
	].join("\n");
}

function formatFragments(fragments) {
	return fragments
		.map((fragment) => [`## Fragment: ${fragment.profilePath}`, ``, fragment.contents.trimEnd()].join("\n"))
		.join("\n\n");
}

async function ensureArtifactPathSafe(projectRoot, auditDir, options) {
	if (options.allowUnignoredArtifacts) {
		return;
	}

	const gitProbeCwd = await nearestExistingAncestor(auditDir, projectRoot);
	const topLevel = await gitOutput(gitProbeCwd, "rev-parse", "--show-toplevel");
	if (!topLevel) {
		return;
	}

	const probePath = join(auditDir, ".audit-flow-probe");
	const relativeProbePath = relative(topLevel, probePath);
	if (relativeProbePath.startsWith("..") || isAbsolute(relativeProbePath)) {
		return;
	}

	try {
		await execFileAsync("git", ["check-ignore", "--quiet", relativeProbePath], { cwd: topLevel });
	} catch {
		throw new Error(
			[
				`Artifact path is inside a git repository but is not ignored: ${auditDir}`,
				"Add `.claude/local/` to `.gitignore` or `.git/info/exclude`, choose an ignored --artifact-root, or pass --allow-unignored-artifacts for an explicit override.",
			].join("\n"),
		);
	}
}

async function nearestExistingAncestor(filePath, fallbackPath) {
	let current = filePath;
	while (current && current !== dirname(current)) {
		if (await fileExists(current)) {
			return current;
		}
		current = dirname(current);
	}
	return fallbackPath;
}

async function gitOutput(projectRoot, ...args) {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: projectRoot });
		return stdout.trim();
	} catch {
		return null;
	}
}

async function readGitMetadata(projectRoot) {
	const git = (...args) => gitOutput(projectRoot, ...args);

	const topLevel = await git("rev-parse", "--show-toplevel");
	if (!topLevel) {
		return null;
	}

	return {
		top_level: topLevel,
		branch: await git("branch", "--show-current"),
		head: await git("rev-parse", "HEAD"),
		status_short_branch: await git("status", "--short", "--branch"),
	};
}

async function readLocalOverrides(projectRoot) {
	const overridesPath = join(projectRoot, ".claude/local/audit.overrides.yaml");
	if (!(await fileExists(overridesPath))) {
		return null;
	}
	return parseYamlSubset(await readFile(overridesPath, "utf8"));
}

function applyLocalOverrides(profile, overrides, env) {
	const nextProfile = structuredClone(profile);
	const platformName = nextProfile.platform?.name;
	const platformOverride = platformName ? overrides?.platforms?.[platformName] : null;
	if (platformOverride?.context_root) {
		nextProfile.platform = {
			...nextProfile.platform,
			context_root: platformOverride.context_root,
		};
	}
	return expandEnvPlaceholders(nextProfile, env);
}

function expandEnvPlaceholders(value, env) {
	if (Array.isArray(value)) {
		return value.map((item) => expandEnvPlaceholders(item, env));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvPlaceholders(item, env)]));
	}
	if (typeof value !== "string") {
		return value;
	}
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?}/g, (_match, name, fallback) => {
		const envValue = env[name];
		if (envValue !== undefined && envValue !== "") {
			return envValue;
		}
		return fallback ?? "";
	});
}

export function parseYamlSubset(text) {
	const root = {};
	const stack = [{ indent: -1, type: "object", value: root }];

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripInlineComment(rawLine);
		if (!line.trim()) {
			continue;
		}

		const indent = countIndent(line);
		const content = line.trim();

		while (stack.length > 1 && indent <= stack.at(-1).indent) {
			stack.pop();
		}

		let parent = stack.at(-1);
		if (parent.type === "pending") {
			const container = content === "-" || content.startsWith("- ") ? [] : {};
			parent.owner[parent.key] = container;
			parent.type = Array.isArray(container) ? "array" : "object";
			parent.value = container;
		}

		parent = stack.at(-1);
		if (content === "-" || content.startsWith("- ")) {
			if (parent.type !== "array") {
				throw new Error(`Invalid YAML subset: list item without list parent: ${rawLine}`);
			}
			const itemText = content === "-" ? "" : content.slice(2).trim();
			if (itemText === "") {
				const item = {};
				parent.value.push(item);
				stack.push({ indent, type: "object", value: item });
			} else if (looksLikeKeyValue(itemText)) {
				const item = {};
				parent.value.push(item);
				const { key, rawValue } = splitKeyValue(itemText);
				if (rawValue === "") {
					stack.push({ indent, type: "object", value: item });
					stack.push({ indent, type: "pending", owner: item, key });
				} else {
					item[key] = parseScalar(rawValue);
					stack.push({ indent, type: "object", value: item });
				}
			} else {
				parent.value.push(parseScalar(itemText));
			}
			continue;
		}

		if (parent.type !== "object") {
			throw new Error(`Invalid YAML subset: key/value without object parent: ${rawLine}`);
		}

		const { key, rawValue } = splitKeyValue(content);
		if (rawValue === "") {
			stack.push({ indent, type: "pending", owner: parent.value, key });
		} else {
			parent.value[key] = parseScalar(rawValue);
		}
	}

	return root;
}

function stripInlineComment(line) {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (inDoubleQuote && char === "\\") {
			i += 1;
			continue;
		}
		if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
		if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
		if (char === "#" && !inSingleQuote && !inDoubleQuote && (i === 0 || /\s/.test(line[i - 1]))) {
			return line.slice(0, i).trimEnd();
		}
	}
	return line;
}

function countIndent(line) {
	let count = 0;
	for (const char of line) {
		if (char === " ") count += 1;
		else break;
	}
	return count;
}

function looksLikeKeyValue(text) {
	return /^[A-Za-z0-9_-]+\s*:/.test(text);
}

function splitKeyValue(text) {
	const match = text.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
	if (!match) {
		throw new Error(`Invalid YAML subset line: ${text}`);
	}
	return { key: match[1], rawValue: match[2] };
}

function parseScalar(value) {
	const trimmed = value.trim();
	if (trimmed === "null" || trimmed === "~") return null;
	if (trimmed === "[]") return [];
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function toYaml(value, indent = 0) {
	const pad = " ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]\n";
		return value
			.map((item) => {
				if (item && typeof item === "object") {
					return `${pad}-\n${toYaml(item, indent + 2)}`;
				}
				return `${pad}- ${formatScalar(item)}\n`;
			})
			.join("");
	}
	if (value && typeof value === "object") {
		return Object.entries(value)
			.map(([key, item]) => {
				if (Array.isArray(item)) {
					return item.length === 0 ? `${pad}${key}: []\n` : `${pad}${key}:\n${toYaml(item, indent + 2)}`;
				}
				if (item && typeof item === "object") {
					return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
				}
				return `${pad}${key}: ${formatScalar(item)}\n`;
			})
			.join("");
	}
	return `${pad}${formatScalar(value)}\n`;
}

function formatScalar(value) {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	return JSON.stringify(String(value));
}

function makeAuditId(now, type, target) {
	const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
	const slug = `${type}-${target}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${timestamp}-${slug || "audit"}`;
}

function relativeFrom(root, filePath) {
	const relative = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
	return relative || ".";
}

async function fileExists(filePath) {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function parseArgs(argv) {
	const options = {};
	const positional = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--profile") options.profile = argv[++i];
		else if (arg === "--target") options.target = argv[++i];
		else if (arg === "--project-root") options.projectRoot = argv[++i];
		else if (arg === "--audit-config-root") options.auditConfigRoot = argv[++i];
		else if (arg === "--audit-id") options.auditId = argv[++i];
		else if (arg === "--artifact-root") options.artifactRoot = argv[++i];
		else if (arg === "--allow-unignored-artifacts") options.allowUnignoredArtifacts = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else positional.push(arg);
	}

	if (!options.profile && positional.length > 0) {
		options.profile = positional.shift();
	}
	if (!options.target && positional.length > 0) {
		options.target = positional.join(" ");
	}
	return options;
}

function usage() {
	return `Usage: node scripts/start-audit.mjs --profile <profile> [--target <target>] [--project-root <path>]\n\nExamples:\n  node scripts/start-audit.mjs --profile pr --target "PR #14"\n  node scripts/start-audit.mjs diff\n  node scripts/start-audit.mjs commit "staged diff"\n\nBy default, artifact paths inside git repositories must be ignored. Add .claude/local/ to .gitignore or pass --allow-unignored-artifacts to override.\n`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const result = await startAudit(options);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
