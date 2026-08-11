#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { updateAuditMetadata } from "./audit-metadata.mjs";
import { assertTargetSnapshotUnchanged, sha256 } from "./snapshot.mjs";
import { assertNoSymlinkComponents } from "./start-audit.mjs";

const FINAL_STATUSES = new Set(["passed", "passed_with_deferred", "blocked"]);
const REQUIRED_STAGES = ["primary", "peer", "final_diff"];
const REQUIRED_ROLES = {
	primary: "primary-reviewer",
	peer: "peer-reviewer",
	final_diff: "final-diff-reviewer",
};
const REQUIRED_PROMPT_ARTIFACTS = {
	primary: "primary_prompt",
	peer: "peer_review_prompt",
	final_diff: "final_diff_prompt",
};
const REQUIRED_REPORT_ARTIFACTS = {
	primary: "primary_initial",
	peer: "peer_review",
	final_diff: "final_diff_review",
};
const FINDING_STATUSES = new Set([
	"candidate",
	"unverified",
	"accepted",
	"rejected",
	"deferred",
	"needs_more_info",
	"fixed",
	"partially_fixed",
	"still_open",
	"verified",
	"commented",
]);
const FINDING_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const FINDING_CONFIDENCES = new Set(["confirmed", "likely", "speculative", "question"]);
const FINDING_RECOMMENDED_ACTIONS = new Set(["fix", "comment", "defer", "ignore", "investigate"]);
const UNRESOLVED_FINDING_STATUSES = new Set([
	"candidate",
	"unverified",
	"accepted",
	"needs_more_info",
	"partially_fixed",
	"still_open",
]);

export async function finalizeAudit(options) {
	const auditYmlPath = resolveAuditYmlPath(options);
	const status = options.status;
	if (!FINAL_STATUSES.has(status)) {
		throw new Error(`Invalid final audit status: ${status ?? "missing"}. Expected passed, passed_with_deferred, or blocked.`);
	}
	await assertNoSymlinkComponents(auditYmlPath, "Audit metadata path");

	return updateAuditMetadata(auditYmlPath, async (audit) => {
		if (audit.finalization || audit.finalized_at || (audit.status ?? "in_progress") !== "in_progress") {
			throw new Error("Audit is already finalized; refusing to overwrite finalization metadata.");
		}
		const auditDir = validateAuditRoot(auditYmlPath, audit);
		await assertNoSymlinkComponents(auditDir, "Audit directory");
		await assertTargetSnapshotUnchanged(audit.target);
		await validateReviewerRuns(audit, auditDir);

		const findingsPath = await resolveRequiredArtifact(auditDir, audit.artifacts?.findings, "findings");
		const receiptPath = await resolveRequiredArtifact(auditDir, audit.artifacts?.receipt, "receipt");
		const findings = await readFile(findingsPath);
		const receipt = await readFile(receiptPath);
		if (receipt.length === 0) throw new Error("Final receipt artifact must not be empty.");
		const parsedFindings = parseFindings(findings, findingsPath);
		validateFindingGate(parsedFindings, status, audit.reviewers);

		const now = options.now ?? new Date();
		assertFinalizationAfterAuditEvents(audit, now);
		const timestamp = now.toISOString();
		audit.status = status;
		audit.updated_at = timestamp;
		audit.finalized_at = timestamp;
		audit.finalization = {
			status,
			target_snapshot_sha256: audit.target.snapshot_sha256,
			findings_sha256: sha256(findings),
			receipt_sha256: sha256(receipt),
			required_stages: REQUIRED_STAGES,
			completed_at: timestamp,
		};
		return { auditYmlPath, auditDir, status, finalizedAt: timestamp };
	});
}

async function validateReviewerRuns(audit, auditDir) {
	const reviewers = audit.reviewers ?? {};
	assertUniqueDispatchIds(reviewers);
	assertUniqueSessionIds(reviewers);
	for (const stage of REQUIRED_STAGES) {
		const reviewer = Object.hasOwn(reviewers, stage) ? reviewers[stage] : undefined;
		if (!reviewer?.completed_at) {
			throw new Error(`Cannot finalize: required reviewer stage ${stage} is incomplete.`);
		}
		if (reviewer.role !== REQUIRED_ROLES[stage]) {
			throw new Error(`Cannot finalize: required reviewer stage ${stage} has the wrong role.`);
		}
	}
	assertRequiredStageOrder(reviewers);
	assertSupplementalStageOrder(reviewers);
	assertReviewerStagesAfterCreation(audit);
	assertDistinctRequiredReports(reviewers);
	for (const [key, reviewer] of Object.entries(reviewers)) {
		if (!REQUIRED_STAGES.includes(key) && (reviewer?.role !== "finding-verifier" || !reviewer.completed_at || !reviewer.dispatch_id)) {
			throw new Error(`Supplemental reviewer ${key} is not a completed finding-verifier dispatch.`);
		}
		if (!reviewer?.completed_at) continue;
		assertNonemptyRunIdentity(reviewer, key);
		const promptArtifactKey = REQUIRED_STAGES.includes(key)
			? REQUIRED_PROMPT_ARTIFACTS[key]
			: `${key.replaceAll("-", "_")}_prompt`;
		const dispatchedPrompt = audit.artifacts?.[promptArtifactKey];
		if (!reviewer.prompt || reviewer.prompt !== dispatchedPrompt) {
			throw new Error(`Cannot finalize: ${key} prompt does not match the dispatched metadata path.`);
		}
		const reportArtifactKey = REQUIRED_STAGES.includes(key)
			? REQUIRED_REPORT_ARTIFACTS[key]
			: key.replaceAll("-", "_");
		const dispatchedReport = audit.artifacts?.[reportArtifactKey];
		if (!reviewer.artifact || reviewer.artifact !== dispatchedReport) {
			throw new Error(`Cannot finalize: ${key} report does not match the dispatched metadata path.`);
		}
		const promptPath = await resolveRequiredArtifact(auditDir, reviewer.prompt, `${key} prompt`);
		const prompt = await readFile(promptPath);
		if (prompt.length === 0) throw new Error(`Cannot finalize: ${key} prompt is empty.`);
		const promptSha256 = sha256(prompt);
		if (!reviewer.prompt_sha256 || reviewer.prompt_sha256 !== promptSha256) {
			throw new Error(`Cannot finalize: ${key} prompt SHA-256 does not match audit metadata.`);
		}
		const reportPath = await resolveRequiredArtifact(auditDir, reviewer.artifact, `${key} report`);
		const report = await readFile(reportPath);
		if (report.length === 0) throw new Error(`Cannot finalize: ${key} report is empty.`);
		if (!reviewer.report_sha256 || reviewer.report_sha256 !== sha256(report)) {
			throw new Error(`Cannot finalize: ${key} report SHA-256 does not match audit metadata.`);
		}
		validateStructuralAttestation(audit, key, reviewer, promptSha256);
	}
}

function assertReviewerStagesAfterCreation(audit) {
	const creationTime = Date.parse(audit.created_at);
	if (!Number.isFinite(creationTime)) {
		throw new Error("Audit created_at must be a valid timestamp.");
	}
	for (const [key, reviewer] of Object.entries(audit.reviewers ?? {})) {
		if (!reviewer?.completed_at) continue;
		const completionTime = Date.parse(reviewer.completed_at);
		if (completionTime < creationTime) {
			throw new Error(`Reviewer ${key} completion timestamp must not precede audit creation.`);
		}
	}
}

function assertFinalizationAfterAuditEvents(audit, now) {
	const finalizationTime = now.getTime();
	if (!Number.isFinite(finalizationTime)) {
		throw new Error("Finalization timestamp must be a valid date.");
	}
	const creationTime = Date.parse(audit.created_at);
	if (!Number.isFinite(creationTime)) {
		throw new Error("Audit created_at must be a valid timestamp.");
	}
	if (finalizationTime < creationTime) {
		throw new Error("Finalization timestamp must not precede audit creation.");
	}
	for (const [key, reviewer] of Object.entries(audit.reviewers ?? {})) {
		if (!reviewer?.completed_at) continue;
		const completionTime = Date.parse(reviewer.completed_at);
		if (finalizationTime < completionTime) {
			throw new Error(`Finalization timestamp must not precede completed reviewer ${key}.`);
		}
	}
}

function assertRequiredStageOrder(reviewers) {
	const timestamps = REQUIRED_STAGES.map((stage) => Date.parse(reviewers[stage]?.completed_at));
	if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
		throw new Error("Required reviewer completion timestamps must be valid dates.");
	}
	for (let index = 1; index < timestamps.length; index += 1) {
		if (timestamps[index] < timestamps[index - 1]) {
			throw new Error("Required reviewer completion timestamps must preserve primary, peer, final_diff order.");
		}
	}
}

function assertSupplementalStageOrder(reviewers) {
	const peerTime = Date.parse(reviewers.peer.completed_at);
	for (const [key, reviewer] of Object.entries(reviewers)) {
		if (REQUIRED_STAGES.includes(key)) continue;
		const completionTime = typeof reviewer?.completed_at === "string" ? Date.parse(reviewer.completed_at) : Number.NaN;
		if (!Number.isFinite(completionTime)) {
			throw new Error(`Supplemental reviewer ${key} has an invalid completion timestamp.`);
		}
		if (completionTime < peerTime) {
			throw new Error(`Supplemental reviewer ${key} must not complete before primary and peer.`);
		}
	}
}

function assertNonemptyRunIdentity(reviewer, key) {
	for (const field of ["tool", "model", "session_id"]) {
		if (typeof reviewer?.[field] !== "string" || reviewer[field].trim() === "") {
			throw new Error(`Cannot finalize: ${key} reviewer has no nonempty ${field}.`);
		}
	}
}

function validateStructuralAttestation(audit, reviewerKey, reviewer, promptSha256) {
	const expected = {
		kind: "orchestrator-attested",
		audit_id: String(audit.id),
		reviewer_key: reviewerKey,
		dispatch_id: String(reviewer.dispatch_id),
		target_snapshot_sha256: String(audit.target?.snapshot_sha256),
		prompt_sha256: promptSha256,
		artifact: String(reviewer.artifact),
		report_sha256: String(reviewer.report_sha256),
		recorded_at: String(reviewer.completed_at),
	};
	if (!reviewer.attestation || typeof reviewer.attestation !== "object") {
		throw new Error(`Cannot finalize: ${reviewerKey} reviewer is missing structural orchestrator attestation.`);
	}
	for (const [field, value] of Object.entries(expected)) {
		if (reviewer.attestation[field] !== value) {
			throw new Error(`Cannot finalize: ${reviewerKey} attestation ${field} does not match recorded reviewer provenance.`);
		}
	}
}

function assertDistinctRequiredReports(reviewers) {
	const hashes = REQUIRED_STAGES.map((stage) => reviewers[stage]?.report_sha256);
	if (hashes.every((hash) => typeof hash === "string" && hash !== "") && new Set(hashes).size !== hashes.length) {
		throw new Error("Required reviewer report hashes must be distinct; copied report bytes are rejected as a defense-in-depth check.");
	}
}

function parseFindings(buffer, findingsPath) {
	let document;
	try {
		document = JSON.parse(buffer.toString("utf8"));
	} catch {
		throw new Error(`Findings artifact is not valid JSON: ${findingsPath}`);
	}
	const findings = Array.isArray(document) ? document : document?.findings;
	if (!Array.isArray(findings)) {
		throw new Error("Findings JSON must be an array or an object with a findings array.");
	}
	return findings;
}

function validateFindingGate(findings, requestedStatus, reviewers) {
	let deferredCount = 0;
	for (const [index, finding] of findings.entries()) {
		if (!finding || typeof finding !== "object") {
			throw new Error(`findings[${index}] must be an object.`);
		}
		validateFindingContent(finding, index);
		const findingId = finding.id;
		if (!FINDING_STATUSES.has(finding.status)) {
			throw new Error(`Finding ${findingId} has invalid or missing status: ${finding.status ?? "missing"}.`);
		}
		validateFindingProvenance(finding, findingId, reviewers);
		if (requestedStatus !== "blocked" && UNRESOLVED_FINDING_STATUSES.has(finding.status)) {
			throw new Error(`Finding ${findingId} is unresolved (${finding.status}); final status must be blocked.`);
		}
		if (requestedStatus === "passed" && finding.status === "deferred") {
			throw new Error(`Finding ${findingId} is deferred; use passed_with_deferred or blocked.`);
		}
		if (finding.status === "deferred") deferredCount += 1;
	}
	if (requestedStatus === "passed_with_deferred" && deferredCount === 0) {
		throw new Error("Final status passed_with_deferred requires at least one deferred finding.");
	}
}

function validateFindingContent(finding, index) {
	for (const field of ["id", "title", "impact", "evidence"]) {
		if (typeof finding[field] !== "string" || finding[field].trim() === "") {
			throw new Error(`findings[${index}].${field} must be a nonempty string.`);
		}
	}
	if (!FINDING_SEVERITIES.has(finding.severity)) {
		throw new Error(`Finding ${finding.id} has invalid or missing severity: ${finding.severity ?? "missing"}.`);
	}
	if (!FINDING_CONFIDENCES.has(finding.confidence)) {
		throw new Error(`Finding ${finding.id} has invalid or missing confidence: ${finding.confidence ?? "missing"}.`);
	}
	if (!FINDING_RECOMMENDED_ACTIONS.has(finding.recommended_action)) {
		throw new Error(`Finding ${finding.id} has invalid or missing recommended_action: ${finding.recommended_action ?? "missing"}.`);
	}
}

function validateFindingProvenance(finding, findingId, reviewers) {
	if (!Array.isArray(finding.source) || finding.source.some((source) => typeof source !== "string" || source.trim() === "")) {
		throw new Error(`Finding ${findingId} source must list concrete nonempty reviewer keys.`);
	}
	const sources = [...new Set(finding.source)];
	const required = finding.verification?.required;
	const artifacts = finding.verification?.artifacts;
	if (!Number.isInteger(required) || required < 2) {
		throw new Error(`Finding ${findingId} verification.required must be an integer of at least 2.`);
	}
	if (sources.length < required) {
		throw new Error(`Finding ${findingId} has not passed its ${required}-reviewer finding verification gate.`);
	}
	if (!Array.isArray(artifacts) || artifacts.some((artifact) => typeof artifact !== "string" || artifact.trim() === "")) {
		throw new Error(`Finding ${findingId} verification.artifacts must list concrete nonempty report artifacts.`);
	}
	const artifactSet = new Set(artifacts);
	const reportHashes = [];
	for (const source of sources) {
		const reviewer = Object.hasOwn(reviewers ?? {}, source) ? reviewers[source] : undefined;
		if (!reviewer?.completed_at) {
			throw new Error(`Finding ${findingId} cites reviewer key without a completed recorded report: ${source}`);
		}
		assertNonemptyRunIdentity(reviewer, source);
		if (!reviewer.attestation || reviewer.attestation.reviewer_key !== source) {
			throw new Error(`Finding ${findingId} cites reviewer key without matching structural attestation: ${source}`);
		}
		if (!artifactSet.has(reviewer.artifact)) {
			throw new Error(`Finding ${findingId} verification.artifacts does not include the report recorded for reviewer key ${source}: ${reviewer.artifact}`);
		}
		reportHashes.push(reviewer.report_sha256);
	}
	if (new Set(reportHashes).size !== reportHashes.length) {
		throw new Error(`Finding ${findingId} cites byte-identical reviewer reports; copied artifacts are rejected as a defense-in-depth check.`);
	}
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

function validateAuditRoot(auditYmlPath, audit) {
	const metadataDir = dirname(auditYmlPath);
	const declaredRoot = audit.artifacts?.root ? String(audit.artifacts.root) : metadataDir;
	const normalized = normalize(declaredRoot);
	if (!isAbsolute(declaredRoot) && normalized.split(sep).includes("..")) {
		throw new Error(`Audit metadata declares an unsafe relative artifact root: ${declaredRoot}`);
	}
	const auditDir = isAbsolute(declaredRoot)
		? resolve(declaredRoot)
		: normalized === "." || metadataDir.endsWith(`${sep}${normalized}`)
			? metadataDir
			: resolve(declaredRoot);
	if (auditDir !== metadataDir || resolve(auditYmlPath) !== join(metadataDir, "audit.yml")) {
		throw new Error(`Audit metadata path does not match its declared artifact root: ${auditYmlPath}`);
	}
	return auditDir;
}

async function resolveRequiredArtifact(auditDir, artifact, label) {
	if (!artifact || typeof artifact !== "string") {
		throw new Error(`Audit metadata is missing the ${label} artifact path.`);
	}
	const artifactPath = isAbsolute(artifact) ? resolve(artifact) : resolve(auditDir, artifact);
	const relativePath = relative(auditDir, artifactPath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`${label} artifact must be inside the selected audit directory: ${artifactPath}`);
	}
	await assertNoSymlinkComponents(artifactPath, `${label} artifact path`);
	try {
		const artifactStat = await stat(artifactPath);
		if (!artifactStat.isFile()) throw new Error("not a file");
	} catch {
		throw new Error(`${label} artifact not found or not a file: ${artifactPath}`);
	}
	return artifactPath;
}

function resolveAuditYmlPath(options) {
	if (options.auditYmlPath) return resolve(options.auditYmlPath);
	if (options.auditDir) return resolve(options.auditDir, "audit.yml");
	throw new Error("Missing audit metadata path. Pass --audit-yml <path> or --audit-dir <path>.");
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--audit-yml") options.auditYmlPath = argv[++index];
		else if (arg === "--audit-dir") options.auditDir = argv[++index];
		else if (arg === "--status") options.status = argv[++index];
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (!options.auditDir && !options.auditYmlPath) options.auditDir = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function usage() {
	return "Usage: node scripts/finalize-audit.mjs --audit-yml <path> --status <passed|passed_with_deferred|blocked>\n";
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const result = await finalizeAudit(options);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
