#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseYamlSubset, toYaml } from "./start-audit.mjs";

const STAGE_CONFIG = {
	primary: {
		reviewerKey: "primary",
		artifactKey: "primary_initial",
		defaultArtifact: "primary-initial.md",
	},
	peer: {
		reviewerKey: "peer",
		artifactKey: "peer_review",
		defaultArtifact: "peer-review.md",
	},
};

export async function recordAuditStage(options) {
	const auditYmlPath = resolveAuditYmlPath(options);
	const stage = options.stage ?? "primary";
	const config = STAGE_CONFIG[stage];
	if (!config) {
		throw new Error(`Unsupported audit stage: ${stage}. Expected one of: ${Object.keys(STAGE_CONFIG).join(", ")}`);
	}

	const audit = parseYamlSubset(await readFile(auditYmlPath, "utf8"));
	const auditDir = audit.artifacts?.root ? String(audit.artifacts.root) : dirname(auditYmlPath);
	const artifactPath = resolveArtifactPath(auditDir, options.artifactPath, audit.artifacts?.[config.artifactKey], config.defaultArtifact);
	await assertFileExists(artifactPath, `${stage} artifact`);

	const now = options.now ?? new Date();
	audit.status = audit.status ?? "in_progress";
	audit.updated_at = now.toISOString();
	audit.reviewers = audit.reviewers ?? {};
	audit.reviewers[config.reviewerKey] = audit.reviewers[config.reviewerKey] ?? { role: `${stage}-reviewer` };

	const reviewer = audit.reviewers[config.reviewerKey];
	reviewer.role = reviewer.role ?? `${stage}-reviewer`;
	if (options.tool !== undefined) reviewer.tool = options.tool;
	if (options.model !== undefined) reviewer.model = options.model;
	if (options.sessionId !== undefined) reviewer.session_id = options.sessionId;
	reviewer.completed_at = now.toISOString();
	reviewer.artifact = relativeArtifact(auditDir, artifactPath);

	await writeFile(auditYmlPath, toYaml(audit), "utf8");

	return {
		auditYmlPath,
		auditDir,
		stage,
		artifactPath,
	};
}

function resolveAuditYmlPath(options) {
	if (options.auditYmlPath) {
		return resolve(options.auditYmlPath);
	}
	if (options.auditDir) {
		return resolve(options.auditDir, "audit.yml");
	}
	throw new Error("Missing audit metadata path. Pass --audit-yml <path> or --audit-dir <path>.");
}

function resolveArtifactPath(auditDir, explicitArtifactPath, metadataArtifact, defaultArtifact) {
	if (explicitArtifactPath) {
		return isAbsolute(explicitArtifactPath) ? explicitArtifactPath : resolve(explicitArtifactPath);
	}
	const artifact = metadataArtifact ?? defaultArtifact;
	return isAbsolute(artifact) ? artifact : resolve(auditDir, artifact);
}

function relativeArtifact(auditDir, artifactPath) {
	const relativePath = relative(auditDir, artifactPath);
	if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
		return relativePath;
	}
	return artifactPath;
}

async function assertFileExists(filePath, label) {
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) {
			throw new Error(`${label} is not a file: ${filePath}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("is not a file")) {
			throw error;
		}
		throw new Error(`${label} not found: ${filePath}`);
	}
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--audit-yml") options.auditYmlPath = argv[++i];
		else if (arg === "--audit-dir") options.auditDir = argv[++i];
		else if (arg === "--stage") options.stage = argv[++i];
		else if (arg === "--artifact") options.artifactPath = argv[++i];
		else if (arg === "--tool") options.tool = argv[++i];
		else if (arg === "--model") options.model = argv[++i];
		else if (arg === "--session-id") options.sessionId = argv[++i];
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (!options.auditDir && !options.auditYmlPath) options.auditDir = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function usage() {
	return `Usage: node scripts/record-stage.mjs --audit-dir <dir> --stage <primary|peer> [--artifact <path>] [--tool <tool>] [--model <model>] [--session-id <id>]\n\nExamples:\n  node scripts/record-stage.mjs --audit-dir .claude/local/audits/20260507-audit --stage primary --tool claude-subagent\n`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const result = await recordAuditStage(options);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
