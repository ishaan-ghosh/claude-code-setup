#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { updateAuditMetadata } from "./audit-metadata.mjs";
import { assertTargetSnapshotUnchanged, sha256 } from "./snapshot.mjs";
import { assertNoSymlinkComponents } from "./start-audit.mjs";

const STAGE_CONFIG = {
	primary: {
		reviewerKey: "primary",
		artifactKey: "primary_initial",
		promptArtifactKey: "primary_prompt",
		defaultArtifact: "primary-initial.md",
		role: "primary-reviewer",
	},
	peer: {
		reviewerKey: "peer",
		artifactKey: "peer_review",
		promptArtifactKey: "peer_review_prompt",
		defaultArtifact: "peer-review.md",
		role: "peer-reviewer",
	},
	"final-diff": {
		reviewerKey: "final_diff",
		artifactKey: "final_diff_review",
		promptArtifactKey: "final_diff_prompt",
		defaultArtifact: "final-diff-review.md",
		role: "final-diff-reviewer",
	},
	verification: {
		reviewerKey: null,
		artifactKey: null,
		promptArtifactKey: null,
		defaultArtifact: null,
		role: "finding-verifier",
	},
};
const RESERVED_YAML_MAPPING_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export async function recordAuditStage(options) {
	const auditYmlPath = resolveAuditYmlPath(options);
	const stage = options.stage ?? "primary";
	const config = STAGE_CONFIG[stage];
	if (!config) {
		throw new Error(`Unsupported audit stage: ${stage}. Expected one of: ${Object.keys(STAGE_CONFIG).join(", ")}`);
	}
	if (stage === "verification" && !options.promptPath) {
		throw new Error("Verification stages require --prompt <verification-<name>-prompt.md>.");
	}
	if (stage !== "verification" && options.promptPath) {
		throw new Error(`--prompt is only valid with --stage verification (received ${stage}).`);
	}
	await assertNoSymlinkComponents(auditYmlPath, "Audit metadata path");
	return updateAuditMetadata(auditYmlPath, async (audit) => {
		if (audit.finalization || audit.finalized_at || (audit.status ?? "in_progress") !== "in_progress") {
			throw new Error("Audit is finalized or not in progress; refusing to record another reviewer stage.");
		}
		const reviewerKey = resolveReviewerKey(stage, config, options.reviewerKey);
		const artifactKey = config.artifactKey ?? reviewerKey.replaceAll("-", "_");
		const promptArtifactKey = config.promptArtifactKey ?? `${reviewerKey.replaceAll("-", "_")}_prompt`;
		const metadataDir = dirname(auditYmlPath);
		const declaredAuditRoot = audit.artifacts?.root ? String(audit.artifacts.root) : metadataDir;
		const auditDir = resolveDeclaredAuditRoot(metadataDir, declaredAuditRoot);
		if (auditDir !== metadataDir || resolve(auditYmlPath) !== join(metadataDir, "audit.yml")) {
			throw new Error(`Audit metadata path does not match its declared artifact root: ${auditYmlPath}`);
		}
		await assertNoSymlinkComponents(auditDir, "Audit directory");
		await assertTargetSnapshotUnchanged(audit.target);
		audit.reviewers = audit.reviewers ?? {};
		audit.artifacts = audit.artifacts ?? { root: auditDir };
		if (stage === "peer" && !audit.reviewers.primary?.completed_at) {
			throw new Error("The blind peer stage requires a completed primary stage.");
		}
		if (stage === "final-diff" && (!audit.reviewers.primary?.completed_at || !audit.reviewers.peer?.completed_at)) {
			throw new Error("The final-diff stage requires completed primary and blind peer stages.");
		}
		if (stage === "verification" && (!audit.reviewers.primary?.completed_at || !audit.reviewers.peer?.completed_at)) {
			throw new Error("Finding verification requires completed primary and blind peer stages.");
		}
		if (stage === "verification" && audit.reviewers[reviewerKey]) {
			throw new Error(`Verification reviewer key collision: ${reviewerKey} is already recorded.`);
		}
		if (stage === "verification" && audit.artifacts[artifactKey]) {
			throw new Error(`Verification artifact metadata key collision: ${artifactKey} is already recorded.`);
		}
		if (stage === "verification" && audit.artifacts[promptArtifactKey]) {
			throw new Error(`Verification prompt metadata key collision: ${promptArtifactKey} is already recorded.`);
		}

		const existingReviewer = audit.reviewers[reviewerKey];
		if (stage !== "verification" && (!existingReviewer || existingReviewer.role !== config.role)) {
			throw new Error(`Audit metadata is missing the dispatched ${config.role} reviewer.`);
		}
		const reviewer = existingReviewer ?? { role: config.role };
		if (reviewer.completed_at || reviewer.report_sha256) {
			throw new Error(`${stage} stage is already recorded; refusing to overwrite reviewer provenance.`);
		}
		const dispatchId = resolveDispatchId(audit.reviewers, reviewerKey, reviewer.dispatch_id, options.dispatchId);
		let promptSha256 = null;
		if (stage !== "verification") {
			const dispatchedPrompt = audit.artifacts[config.promptArtifactKey];
			if (!reviewer.prompt || reviewer.prompt !== dispatchedPrompt) {
				throw new Error(`${stage} reviewer prompt must match the dispatched metadata path: ${dispatchedPrompt ?? "missing"}`);
			}
			promptSha256 = await validatePromptDigest(auditDir, reviewer, stage);
		} else {
			const promptPath = resolveArtifactPath(auditDir, options.promptPath, null, null);
			assertInsideAuditDirectory(auditDir, promptPath, "verification prompt");
			await assertNoSymlinkComponents(promptPath, "verification prompt path");
			await assertFileExists(promptPath, "verification prompt");
			if (!/^verification-[A-Za-z0-9._-]+-prompt\.md$/.test(basename(promptPath))) {
				throw new Error("Verification prompt filename must match verification-<name>-prompt.md.");
			}
			const prompt = await readFile(promptPath);
			if (prompt.length === 0) throw new Error(`verification prompt must not be empty: ${promptPath}`);
			reviewer.prompt = relativeArtifact(auditDir, promptPath);
			reviewer.prompt_sha256 = sha256(prompt);
			promptSha256 = reviewer.prompt_sha256;
		}
		const identity = resolveRunIdentity(options, stage);

		const artifactPath = resolveArtifactPath(
			auditDir,
			options.artifactPath,
			audit.artifacts[artifactKey],
			config.defaultArtifact,
		);
		assertInsideAuditDirectory(auditDir, artifactPath, `${stage} artifact`);
		await assertNoSymlinkComponents(artifactPath, `${stage} artifact path`);
		await assertFileExists(artifactPath, `${stage} artifact`);
		if (
			stage !== "verification" &&
			audit.artifacts[artifactKey] &&
			relativeArtifact(auditDir, artifactPath) !== String(audit.artifacts[artifactKey])
		) {
			throw new Error(`${stage} artifact must match the dispatched metadata path: ${audit.artifacts[artifactKey]}`);
		}
		if (stage === "verification" && !/^verification-[A-Za-z0-9._-]+\.md$/.test(basename(artifactPath))) {
			throw new Error("Verification artifact filename must match verification-<name>.md.");
		}
		const report = await readFile(artifactPath);
		if (report.length === 0) throw new Error(`${stage} artifact must not be empty: ${artifactPath}`);
		const reportSha256 = sha256(report);
		if (
			stage !== "verification" &&
			Object.entries(audit.reviewers).some(
				([key, candidate]) => key !== reviewerKey && candidate?.completed_at && candidate.report_sha256 === reportSha256,
			)
		) {
			throw new Error(`${stage} report is byte-identical to an already-recorded reviewer report.`);
		}
		const recordedArtifact = relativeArtifact(auditDir, artifactPath);
		if (
			stage === "verification" &&
			Object.entries(audit.artifacts).some(
				([key, value]) => key !== "root" && String(value) === recordedArtifact,
			)
		) {
			throw new Error(`Verification artifact is already recorded by another reviewer: ${recordedArtifact}`);
		}
		if (stage === "verification" && recordedArtifact === reviewer.prompt) {
			throw new Error("Verification prompt and report must be different artifacts.");
		}

		const now = options.now ?? new Date();
		assertCompletionTimeAfterPrerequisites(audit, stage, now);
		const recordedAt = now.toISOString();
		reviewer.role = config.role;
		reviewer.dispatch_id = dispatchId;
		reviewer.tool = identity.tool;
		reviewer.model = identity.model;
		reviewer.session_id = identity.sessionId;
		if (options.scope !== undefined) reviewer.scope = options.scope;
		reviewer.completed_at = recordedAt;
		reviewer.artifact = recordedArtifact;
		reviewer.report_sha256 = reportSha256;
		reviewer.attestation = {
			kind: "orchestrator-attested",
			audit_id: String(audit.id),
			reviewer_key: reviewerKey,
			dispatch_id: dispatchId,
			target_snapshot_sha256: String(audit.target.snapshot_sha256),
			prompt_sha256: promptSha256,
			artifact: recordedArtifact,
			report_sha256: reportSha256,
			recorded_at: recordedAt,
		};
		audit.reviewers[reviewerKey] = reviewer;
		audit.artifacts[artifactKey] = recordedArtifact;
		if (stage === "verification") audit.artifacts[promptArtifactKey] = reviewer.prompt;
		assertUniqueDispatchIds(audit.reviewers);
		assertUniqueSessionIds(audit.reviewers);
		audit.status = audit.status ?? "in_progress";
		audit.updated_at = recordedAt;

		return { auditYmlPath, auditDir, stage, reviewerKey, artifactPath, dispatchId, reportSha256: reviewer.report_sha256 };
	});
}

function assertCompletionTimeAfterPrerequisites(audit, stage, now) {
	const creationTime = Date.parse(audit.created_at);
	if (!Number.isFinite(creationTime)) {
		throw new Error("Audit created_at must be a valid timestamp before recording reviewer completion.");
	}
	if (now.getTime() < creationTime) {
		throw new Error(`${stage} completion time must not precede audit creation.`);
	}
	const reviewers = audit.reviewers ?? {};
	const prerequisiteKeys = stage === "primary" ? [] : ["primary", "peer"];
	if (stage === "peer") prerequisiteKeys.pop();
	for (const key of prerequisiteKeys) {
		const prerequisiteTime = Date.parse(reviewers[key]?.completed_at);
		if (!Number.isFinite(prerequisiteTime) || now.getTime() < prerequisiteTime) {
			throw new Error(`${stage} completion time must not precede the completed ${key} stage.`);
		}
	}
}

async function validatePromptDigest(auditDir, reviewer, stage) {
	if (!reviewer.prompt || typeof reviewer.prompt !== "string") {
		throw new Error(`${stage} reviewer metadata is missing its dispatched prompt path.`);
	}
	if (!reviewer.prompt_sha256) throw new Error(`${stage} reviewer metadata is missing prompt_sha256.`);
	const promptPath = resolveArtifactPath(auditDir, reviewer.prompt, null, null);
	assertInsideAuditDirectory(auditDir, promptPath, `${stage} prompt`);
	await assertNoSymlinkComponents(promptPath, `${stage} prompt path`);
	await assertFileExists(promptPath, `${stage} prompt`);
	const actual = sha256(await readFile(promptPath));
	if (actual !== reviewer.prompt_sha256) {
		throw new Error(`${stage} prompt digest mismatch; refusing to record a report for altered instructions.`);
	}
	return actual;
}

function resolveRunIdentity(options, stage) {
	const identity = {
		tool: normalizeRequiredIdentity(options.tool, "tool", stage),
		model: normalizeRequiredIdentity(options.model, "model", stage),
		sessionId: normalizeRequiredIdentity(options.sessionId, "session ID", stage),
	};
	return identity;
}

function normalizeRequiredIdentity(value, label, stage) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${stage} stage requires a nonempty ${label} for structural run provenance.`);
	}
	return value.trim();
}

function resolveDispatchId(reviewers, reviewerKey, existing, explicit) {
	if (existing && explicit && existing !== explicit) {
		throw new Error(`Dispatch ID does not match the generated reviewer run ID for ${reviewerKey}.`);
	}
	const dispatchId = String(existing ?? explicit ?? randomUUID());
	if (!dispatchId) throw new Error("Reviewer dispatch ID must not be empty.");
	for (const [key, reviewer] of Object.entries(reviewers)) {
		if (key !== reviewerKey && reviewer?.dispatch_id === dispatchId) {
			throw new Error(`Reviewer dispatch ID must be unique; already used by ${key}.`);
		}
	}
	return dispatchId;
}

function assertUniqueDispatchIds(reviewers) {
	const dispatchIds = Object.values(reviewers ?? {}).map((reviewer) => reviewer?.dispatch_id);
	if (dispatchIds.some((value) => value === null || value === undefined || value === "")) {
		throw new Error("Every reviewer must have a dispatch ID.");
	}
	if (new Set(dispatchIds.map(String)).size !== dispatchIds.length) {
		throw new Error("Reviewer dispatch IDs must be distinct within an audit.");
	}
}

function assertUniqueSessionIds(reviewers) {
	const completed = Object.values(reviewers ?? {}).filter((reviewer) => reviewer?.completed_at);
	if (completed.some((reviewer) => typeof reviewer.session_id !== "string" || reviewer.session_id.trim() === "")) {
		throw new Error("Every completed reviewer must have a nonempty session ID.");
	}
	const sessionIds = completed.map((reviewer) => reviewer.session_id.trim());
	if (new Set(sessionIds).size !== sessionIds.length) {
		throw new Error("Reviewer session IDs must be distinct within an audit.");
	}
}

function assertInsideAuditDirectory(auditDir, candidatePath, label) {
	const relativePath = relative(auditDir, candidatePath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`${label} must be inside the selected audit directory: ${candidatePath}`);
	}
}

function resolveDeclaredAuditRoot(metadataDir, declaredAuditRoot) {
	if (isAbsolute(declaredAuditRoot)) {
		return resolve(declaredAuditRoot);
	}
	const normalizedRoot = normalize(declaredAuditRoot);
	const components = normalizedRoot.split(sep);
	if (components.includes("..")) {
		throw new Error(`Audit metadata declares an unsafe relative artifact root: ${declaredAuditRoot}`);
	}
	if (normalizedRoot === "." || metadataDir.endsWith(`${sep}${normalizedRoot}`)) {
		return metadataDir;
	}
	return resolve(declaredAuditRoot);
}

function resolveReviewerKey(stage, config, explicitReviewerKey) {
	if (stage === "verification" && !explicitReviewerKey) {
		throw new Error("Verification stages require --reviewer-key <key>.");
	}
	if (stage !== "verification" && explicitReviewerKey) {
		throw new Error(`--reviewer-key is only valid with --stage verification (received ${stage}).`);
	}
	const reviewerKey = explicitReviewerKey ?? config.reviewerKey;
	if (RESERVED_YAML_MAPPING_KEYS.has(reviewerKey)) {
		throw new Error(`Reviewer key is a reserved YAML mapping key: ${reviewerKey}`);
	}
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(reviewerKey)) {
		throw new Error("Reviewer key must start with a letter and contain only letters, numbers, underscores, or hyphens.");
	}
	return reviewerKey;
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
		return isAbsolute(explicitArtifactPath) ? explicitArtifactPath : resolve(auditDir, explicitArtifactPath);
	}
	const artifact = metadataArtifact ?? defaultArtifact;
	if (!artifact) {
		throw new Error("Missing verification artifact. Pass --artifact <verification-*.md>.");
	}
	return isAbsolute(artifact) ? artifact : resolve(auditDir, artifact);
}

function relativeArtifact(auditDir, artifactPath) {
	const relativePath = relative(auditDir, artifactPath);
	if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
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
		else if (arg === "--prompt") options.promptPath = argv[++i];
		else if (arg === "--tool") options.tool = argv[++i];
		else if (arg === "--model") options.model = argv[++i];
		else if (arg === "--session-id") options.sessionId = argv[++i];
		else if (arg === "--dispatch-id") options.dispatchId = argv[++i];
		else if (arg === "--reviewer-key") options.reviewerKey = argv[++i];
		else if (arg === "--scope") options.scope = argv[++i];
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (!options.auditDir && !options.auditYmlPath) options.auditDir = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function usage() {
	return `Usage: node scripts/record-stage.mjs --audit-dir <dir> --stage <primary|peer|final-diff|verification> [--artifact <path>] [--prompt <verification-*-prompt.md>] --tool <tool> --model <model> --session-id <id> [--dispatch-id <id>] [--reviewer-key <key>] [--scope <scope>]\n\nExamples:\n  node scripts/record-stage.mjs --audit-dir .audit/local/audits/20260507-audit --stage primary --tool claude-subagent --model claude-example --session-id primary-run\n  node scripts/record-stage.mjs --audit-dir .audit/local/audits/20260507-audit --stage peer --tool external-peer-agent --model peer-example --session-id peer-run\n  node scripts/record-stage.mjs --audit-dir .audit/local/audits/20260507-audit --stage final-diff --tool claude-subagent --model claude-example --session-id final-run\n  node scripts/record-stage.mjs --audit-dir .audit/local/audits/20260507-audit --stage verification --reviewer-key verifier-peer-only --prompt verification-peer-only-prompt.md --artifact verification-peer-only.md --scope "peer-only findings" --tool claude-subagent --model claude-example --session-id verifier-run\n`;
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
