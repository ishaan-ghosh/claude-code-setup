import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { parseYamlSubset, startAudit, toYaml } from "../scripts/start-audit.mjs";
import { finalizeAudit } from "../scripts/finalize-audit.mjs";
import { recordAuditStage as recordAuditStageRaw } from "../scripts/record-stage.mjs";
import {
	assertTargetSnapshotUnchanged,
	captureTargetSnapshot,
	sha256,
	stableJson,
} from "../scripts/snapshot.mjs";

const execFileAsync = promisify(execFile);

async function writeText(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents, "utf8");
}

async function initGitRepo(projectRoot, { ignoredArtifacts = true } = {}) {
	await mkdir(projectRoot, { recursive: true });
	await execFileAsync("git", ["init"], { cwd: projectRoot });
	await writeText(path.join(projectRoot, ".audit-test-seed"), "seed\n");
	if (ignoredArtifacts) {
		await writeText(path.join(projectRoot, ".gitignore"), [
			".audit/local/",
			".claude/local/",
			"profile-artifacts/",
			"cli-artifacts/",
			"ignored-profile-artifacts/",
			"",
		].join("\n"));
	}
	await execFileAsync("git", ["add", "."], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
		cwd: projectRoot,
	});
}

async function createGitProject(prefix = "audit-flow-") {
	const projectRoot = await mkdtemp(path.join(tmpdir(), prefix));
	await initGitRepo(projectRoot);
	return projectRoot;
}

async function addGitCommit(projectRoot, name = "second.txt", contents = "second\n") {
	await writeText(path.join(projectRoot, name), contents);
	await execFileAsync("git", ["add", name], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", name], {
		cwd: projectRoot,
	});
}

async function recordAuditStage(options) {
	const identity = options.reviewerKey ?? options.stage ?? "primary";
	let promptPath = options.promptPath;
	if (options.stage === "verification" && !promptPath) {
		promptPath = `verification-${identity}-prompt.md`;
		const auditDir = options.auditYmlPath ? path.dirname(options.auditYmlPath) : options.auditDir;
		await writeText(path.join(auditDir, promptPath), `# Focused prompt for ${identity}\n`);
	}
	return recordAuditStageRaw({
		tool: `${identity}-tool`,
		model: `${identity}-model`,
		sessionId: `${identity}-session`,
		...(promptPath ? { promptPath } : {}),
		...options,
	});
}

async function recordRequiredStages(result, prefix = "Report") {
	for (const [stage, artifact] of [
		["primary", result.primaryInitialPath],
		["peer", result.peerReviewPath],
		["final-diff", result.finalDiffReviewPath],
	]) {
		await writeText(artifact, `# ${prefix} ${stage}\n`);
		await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage });
	}
}

function promptSnapshotRecords(prompt) {
	return prompt
		.split("\n")
		.filter((line) => line.startsWith("- {\"capture\":"))
		.map((line) => JSON.parse(line.slice(2)));
}

function resolvedPromptIdentity(repo) {
	return {
		base_oid: repo.base_oid,
		head_oid: repo.head_oid,
		staged_diff_sha256: repo.staged_diff_sha256,
		unstaged_diff_sha256: repo.unstaged_diff_sha256,
		tracked_manifest_sha256: repo.tracked_manifest_sha256,
		tracked_count: repo.tracked.length,
		untracked_manifest_sha256: repo.untracked_manifest_sha256,
		untracked_count: repo.untracked.length,
		snapshot_sha256: repo.snapshot_sha256,
	};
}

test("YAML subset rejects reserved mapping keys recursively", () => {
	for (const key of ["__proto__", "prototype", "constructor"]) {
		assert.throws(
			() => parseYamlSubset(["reviewers:", `  ${key}:`, "    role: finding-verifier", ""].join("\n")),
			new RegExp(`reserved YAML mapping key.*${key}`),
		);
		assert.throws(
			() => parseYamlSubset(["repos:", `  - ${key}: value`, ""].join("\n")),
			new RegExp(`reserved YAML mapping key.*${key}`),
		);
	}
});

test("record-stage rejects reserved reviewer keys before writing metadata", async () => {
	const projectRoot = await createGitProject("audit-flow-reserved-reviewer-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "reserved-reviewer", env: {} });
	const before = await readFile(result.auditYmlPath, "utf8");
	for (const reviewerKey of ["__proto__", "prototype", "constructor"]) {
		await assert.rejects(
			() => recordAuditStageRaw({
				auditYmlPath: result.auditYmlPath,
				stage: "verification",
				reviewerKey,
				promptPath: "verification-safe-prompt.md",
				artifactPath: "verification-safe.md",
				tool: "test-tool",
				model: "test-model",
				sessionId: `reserved-${reviewerKey}`,
			}),
			/reserved YAML mapping key/,
		);
	}
	assert.equal(await readFile(result.auditYmlPath, "utf8"), before);
});

test("creates an audit workspace from a profile and prompt fragments", async () => {
	const projectRoot = await createGitProject();
	await addGitCommit(projectRoot);
	await writeText(
		path.join(projectRoot, ".claude/audit/profiles/pr.yaml"),
		[
			"name: pr",
			"description: Pull request audit",
			"type: pr",
			"base: HEAD~1",
			"head: HEAD",
			"fragments:",
			"  - prompts/base.md",
			"  - prompts/output-format.md",
			"",
		].join("\n"),
	);
	await writeText(
		path.join(projectRoot, ".claude/audit/prompts/base.md"),
		"# Base\n\nAudit concrete regressions.\nRepository fragment says to read primary-initial.md.\n",
	);
	await writeText(path.join(projectRoot, ".claude/audit/prompts/output-format.md"), "# Output\n\nFindings first.\n");

	const result = await startAudit({
		projectRoot,
		profile: "pr",
		target: "PR #42",
		auditId: "audit-test",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});

	assert.equal(result.auditId, "audit-test");
	assert.equal(result.auditDir, path.join(projectRoot, ".claude/local/audits/audit-test"));

	const auditYml = await readFile(result.auditYmlPath, "utf8");
	assert.match(auditYml, /id: "audit-test"/);
	assert.match(auditYml, /type: "pr"/);
	assert.match(auditYml, /raw: "PR #42"/);
	assert.match(auditYml, /primary-initial\.md/);
	assert.match(auditYml, /peer-review\.md/);
	assert.match(auditYml, /local_overrides: \[]/);

	const legacyMetadata = parseYamlSubset(auditYml);
	assert.equal(legacyMetadata.profile.source, "repo-legacy");
	assert.equal(legacyMetadata.artifacts.root_source, "legacy-fallback");

	const primaryPrompt = await readFile(result.primaryPromptPath, "utf8");
	assert.match(primaryPrompt, /You are the primary-reviewer/);
	assert.match(primaryPrompt, /Target: PR #42/);
	assert.match(primaryPrompt, /# Base/);
	assert.match(primaryPrompt, /Audit concrete regressions/);
	assert.match(primaryPrompt, /# Output/);
	assert.match(primaryPrompt, /Do not edit application code/);

	const peerPrompt = await readFile(result.peerPromptPath, "utf8");
	assert.match(peerPrompt, /You are the peer-reviewer/);
	assert.match(peerPrompt, /blind raw-target review/);
	assert.doesNotMatch(peerPrompt, /primary-initial\.md/);
	assert.doesNotMatch(peerPrompt, /# Base|Audit concrete regressions|# Output|Findings first/);
	assert.match(peerPrompt, /Repository-controlled profile fragments are intentionally omitted/);
	assert.match(peerPrompt, /Do not edit application code/);
});

test("records portable platform metadata with local path overrides", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
	await initGitRepo(path.join(projectRoot, "backend"));
	await initGitRepo(path.join(projectRoot, "RoboEval-frontend"));
	await writeText(
		path.join(projectRoot, ".claude/audit/profiles/platform.yaml"),
		[
			"name: platform",
			"type: platform",
			"fragments:",
			"  - prompts/base.md",
			"platform:",
			"  name: RoboEval",
			"  context_root: ${ROBOEVAL_ROOT:-..}",
			"repos:",
			"  - name: backend",
			"    role: api-worker-sandbox",
			"    path: backend",
			"  - name: frontend",
			"    role: web-ui",
			"    path: RoboEval-frontend",
			"artifact_root:",
			"  repo: backend",
			"  path: .claude/local/audits",
			"",
		].join("\n"),
	);
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Base\n");
	await writeText(
		path.join(projectRoot, ".claude/local/audit.overrides.yaml"),
		[
			"platforms:",
			"  RoboEval:",
			`    context_root: ${projectRoot}`,
			"",
		].join("\n"),
	);

	const result = await startAudit({
		projectRoot,
		profile: "platform",
		target: "current platform diff",
		auditId: "platform-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: { ROBOEVAL_ROOT: "/env/RoboEval" },
	});

	assert.equal(result.auditDir, path.join(projectRoot, "backend/.claude/local/audits/platform-audit"));

	const auditYml = await readFile(result.auditYmlPath, "utf8");
	assert.match(auditYml, /platform:/);
	assert.match(auditYml, /name: "RoboEval"/);
	assert.ok(auditYml.includes(`context_root: "${projectRoot}"`));
	assert.match(auditYml, /local_overrides:/);
	assert.match(auditYml, /.claude\/local\/audit.overrides.yaml/);
	assert.match(auditYml, /role: "api-worker-sandbox"/);
	assert.match(auditYml, /role: "web-ui"/);
});

test("maps common audit commands to profiles and strips inline YAML comments", async () => {
	const projectRoot = await createGitProject();
	await writeText(
		path.join(projectRoot, ".claude/audit/profiles/commit.yaml"),
		[
			"name: commit",
			"type: commit # commit | pr | platform",
			"fragments:",
			"  - prompts/base.md # shared base fragment",
			"",
		].join("\n"),
	);
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Base\n");

	const result = await startAudit({
		projectRoot,
		profile: "diff",
		auditId: "diff-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});

	const auditYml = await readFile(result.auditYmlPath, "utf8");
	assert.match(auditYml, /type: "commit"/);
	assert.match(auditYml, /raw: "diff"/);
	const primaryPrompt = await readFile(result.primaryPromptPath, "utf8");
	assert.match(primaryPrompt, /# Base/);
});

test("PR and stack audits fail closed without explicit distinct refs", async () => {
	const projectRoot = await createGitProject("audit-flow-pr-refs-");
	await assert.rejects(
		() => startAudit({ projectRoot, profile: "pr", auditId: "missing-pr-refs", env: {} }),
		/require explicit base and head refs/,
	);
	await assert.rejects(
		() => startAudit({ projectRoot, profile: "stack", base: "HEAD", head: "HEAD", auditId: "equal-stack-refs", env: {} }),
		/must resolve to different commits/,
	);
	await addGitCommit(projectRoot, "pr-change.txt", "change\n");
	const result = await startAudit({
		projectRoot,
		profile: "pr",
		base: "HEAD~1",
		head: "HEAD",
		auditId: "explicit-pr-refs",
		env: {},
	});
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(metadata.target.repos[0].base_ref, "HEAD~1");
	assert.equal(metadata.target.repos[0].head_ref, "HEAD");
	assert.notEqual(metadata.target.repos[0].base_oid, metadata.target.repos[0].head_oid);
});

test("prefers neutral config and refuses unignored neutral artifacts inside a git repo", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
	await initGitRepo(projectRoot, { ignoredArtifacts: false });
	await writeText(
		path.join(projectRoot, ".audit/profiles/commit.yaml"),
		[
			"name: commit",
			"type: commit",
			"fragments:",
			"  - prompts/base.md",
			"",
		].join("\n"),
	);
	await writeText(path.join(projectRoot, ".audit/prompts/base.md"), "# Base\n");

	await assert.rejects(
		() =>
			startAudit({
				projectRoot,
				profile: "commit",
				auditId: "unsafe-audit",
				now: new Date("2026-05-07T00:00:00.000Z"),
				env: {},
			}),
		/Artifact path is inside a git repository but is not ignored/,
	);
	await assert.rejects(
		() => startAudit({
			projectRoot,
			profile: "commit",
			auditId: "unsafe-override",
			allowUnignoredArtifacts: true,
			env: {},
		}),
		/incompatible with immutable target snapshots/,
	);

	await writeText(path.join(projectRoot, ".gitignore"), ".audit/local/\n");
	const result = await startAudit({
		projectRoot,
		profile: "commit",
		auditId: "safe-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});

	assert.equal(result.auditDir, path.join(projectRoot, ".audit/local/audits/safe-audit"));
	assert.equal(result.artifactRootSource, "neutral-default");
});

test("rejects an ignore rule that covers only the predictable probe", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-probe-only-"));
	await initGitRepo(projectRoot, { ignoredArtifacts: false });
	await writeText(path.join(projectRoot, ".gitignore"), ".audit/local/audits/probe-only/.audit-flow-probe\n");
	await execFileAsync("git", ["add", ".gitignore"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "probe ignore"], { cwd: projectRoot });
	await writeText(path.join(projectRoot, ".audit/profiles/commit.yaml"), [
		"name: commit",
		"type: commit",
		"fragments: []",
		"",
	].join("\n"));

	await assert.rejects(
		() => startAudit({ projectRoot, profile: "commit", auditId: "probe-only", env: {} }),
		/planned artifact is not ignored.*audit\.yml/,
	);
	await assert.rejects(() => readFile(path.join(projectRoot, ".audit/local/audits/probe-only/audit.yml")), { code: "ENOENT" });
});

test("requires the audit directory itself to be ignored for future verifier artifacts", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-selective-ignore-"));
	await initGitRepo(projectRoot, { ignoredArtifacts: false });
	const auditPrefix = ".audit/local/audits/selective-ignore";
	const plannedArtifacts = [
		"audit.yml",
		"primary-reviewer-prompt.md",
		"primary-initial.md",
		"primary-findings.json",
		"peer-review-prompt.md",
		"peer-review.md",
		"final-diff-reviewer-prompt.md",
		"final-diff-review.md",
		"synthesis.md",
		"findings.json",
		"final-human-reviewed.md",
		"final-plan.md",
		"receipt.md",
	];
	await writeText(path.join(projectRoot, ".gitignore"), [
		...plannedArtifacts.map((name) => `${auditPrefix}/${name}`),
		`${auditPrefix}/verification-[0-9a-f]*.md`,
		`${auditPrefix}/verification-[0-9a-f]*-prompt.md`,
		"",
	].join("\n"));
	await execFileAsync("git", ["add", ".gitignore"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "selective ignore"], { cwd: projectRoot });
	await writeText(path.join(projectRoot, ".audit/profiles/commit.yaml"), [
		"name: commit",
		"type: commit",
		"fragments: []",
		"",
	].join("\n"));

	await assert.rejects(
		() => startAudit({ projectRoot, profile: "commit", auditId: "selective-ignore", env: {} }),
		/Artifact directory itself must be ignored/,
	);
	await assert.rejects(() => readFile(path.join(projectRoot, auditPrefix, "audit.yml")), { code: "ENOENT" });
});

test("repository-controlled profiles confine fragments after environment expansion", async (t) => {
	for (const [label, configRoot] of [
		["neutral", ".audit"],
		["legacy", ".claude/audit"],
	]) {
		await t.test(label, async () => {
			const projectRoot = await createGitProject(`audit-flow-fragment-${label}-`);
			const outsidePath = path.join(projectRoot, "outside-fragment.md");
			await writeText(outsidePath, "INERT OUTSIDE FRAGMENT\n");
			for (const [name, fragment, env] of [
				["absolute", outsidePath, {}],
				["parent", "../outside-fragment.md", {}],
				["environment", "${OUTSIDE_FRAGMENT}", { OUTSIDE_FRAGMENT: outsidePath }],
			]) {
				await writeText(path.join(projectRoot, configRoot, `profiles/${name}.yaml`), [
					`name: ${name}`,
					"type: commit",
					"fragments:",
					`  - ${fragment}`,
					"",
				].join("\n"));
				await assert.rejects(
					() => startAudit({ projectRoot, profile: name, auditId: `${label}-${name}`, env }),
					/repository-controlled fragment must remain inside its audit config root/,
				);
			}
		});
	}
});

test("explicitly selected config roots may opt into external fragments", async () => {
	const projectRoot = await createGitProject("audit-flow-explicit-fragment-");
	const outsidePath = path.join(projectRoot, "outside-explicit.md");
	await writeText(outsidePath, "INERT EXPLICIT FRAGMENT\n");
	await writeText(path.join(projectRoot, "explicit-config/profiles/commit.yaml"), [
		"name: commit",
		"type: commit",
		"fragments:",
		`  - ${outsidePath}`,
		"",
	].join("\n"));
	const result = await startAudit({
		projectRoot,
		profile: "commit",
		auditConfigRoot: "explicit-config",
		artifactRoot: "cli-artifacts",
		auditId: "explicit-external-fragment",
		env: {},
	});
	assert.match(await readFile(result.primaryPromptPath, "utf8"), /INERT EXPLICIT FRAGMENT/);
});

test("falls back to built-in profiles when a repo has no local audit profile", async () => {
	const projectRoot = await createGitProject();

	const result = await startAudit({
		projectRoot,
		profile: "diff",
		auditId: "default-profile-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});

	const auditYml = await readFile(result.auditYmlPath, "utf8");
	assert.match(auditYml, /source: "default"/);
	assert.match(auditYml, /type: "commit"/);
	assert.match(auditYml, /raw: "diff"/);
	assert.equal(result.auditDir, path.join(projectRoot, ".claude/local/audits/default-profile-audit"));
	assert.equal(result.artifactRootSource, "legacy-fallback");

	const primaryPrompt = await readFile(result.primaryPromptPath, "utf8");
	assert.match(primaryPrompt, /# Audit base/);
	assert.match(primaryPrompt, /# Output format/);
});

test("checks artifact ignore safety in the selected platform member repo", async () => {
	const platformRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-platform-"));
	const backendRoot = path.join(platformRoot, "backend");
	await initGitRepo(backendRoot, { ignoredArtifacts: false });
	await writeText(
		path.join(platformRoot, ".claude/audit/profiles/platform.yaml"),
		[
			"name: platform",
			"type: platform",
			"fragments:",
			"  - prompts/base.md",
			"platform:",
			"  name: ExamplePlatform",
			"  context_root: .",
			"repos:",
			"  - name: backend",
			"    role: api",
			"    path: backend",
			"artifact_root:",
			"  repo: backend",
			"  path: .claude/local/audits",
			"",
		].join("\n"),
	);
	await writeText(path.join(platformRoot, ".claude/audit/prompts/base.md"), "# Base\n");

	await assert.rejects(
		() =>
			startAudit({
				projectRoot: platformRoot,
				profile: "platform",
				auditId: "platform-unsafe",
				now: new Date("2026-05-07T00:00:00.000Z"),
				env: {},
			}),
		/Artifact path is inside a git repository but is not ignored/,
	);

	await writeText(path.join(backendRoot, ".gitignore"), ".claude/local/\n");
	const result = await startAudit({
		projectRoot: platformRoot,
		profile: "platform",
		auditId: "platform-safe",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	assert.equal(result.auditDir, path.join(backendRoot, ".claude/local/audits/platform-safe"));

	await writeText(result.primaryInitialPath, "# Primary audit\n\nNo findings.\n");
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "primary",
		artifactPath: result.primaryInitialPath,
		now: new Date("2026-05-07T01:00:00.000Z"),
	});

	const auditYml = await readFile(result.auditYmlPath, "utf8");
	assert.match(auditYml, /completed_at: "2026-05-07T01:00:00.000Z"/);
	assert.match(auditYml, /role: "api"/);
});

test("records completed primary reviewer metadata without changing the artifact names", async () => {
	const projectRoot = await createGitProject();
	await writeText(path.join(projectRoot, ".claude/audit/profiles/commit.yaml"), [
		"name: commit",
		"type: commit",
		"fragments:",
		"  - prompts/base.md",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Base\n");

	const result = await startAudit({
		projectRoot,
		profile: "commit",
		auditId: "primary-record-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	await writeText(result.primaryInitialPath, "# Primary audit\n\nNo findings.\n");

	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "primary",
		artifactPath: "primary-initial.md",
		tool: "claude-subagent",
		model: "test-model",
		sessionId: "run-123",
		now: new Date("2026-05-07T01:00:00.000Z"),
	});

	const auditYml = await readFile(result.auditYmlPath, "utf8");
	assert.match(auditYml, /status: "in_progress"/);
	assert.match(auditYml, /updated_at: "2026-05-07T01:00:00.000Z"/);
	assert.match(auditYml, /role: "primary-reviewer"/);
	assert.match(auditYml, /tool: "claude-subagent"/);
	assert.match(auditYml, /model: "test-model"/);
	assert.match(auditYml, /session_id: "run-123"/);
	assert.match(auditYml, /completed_at: "2026-05-07T01:00:00.000Z"/);
	assert.match(auditYml, /artifact: "primary-initial.md"/);
	assert.match(auditYml, /local_overrides: \[]/);
});

test("record-stage preserves escaped git status metadata", async () => {
	const projectRoot = await createGitProject();
	await execFileAsync("git", ["init"], { cwd: projectRoot });
	await writeText(path.join(projectRoot, ".gitignore"), ".claude/local/\n");
	await writeText(path.join(projectRoot, "tracked.txt"), "before\n");
	await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
		cwd: projectRoot,
	});
	await writeText(path.join(projectRoot, "tracked.txt"), "after\n");
	await writeText(path.join(projectRoot, ".claude/audit/profiles/commit.yaml"), [
		"name: commit",
		"type: commit",
		"fragments:",
		"  - prompts/base.md",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Base\n");

	const result = await startAudit({
		projectRoot,
		profile: "commit",
		auditId: "escape-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	await writeText(result.primaryInitialPath, "# Primary audit\n");
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "primary",
		artifactPath: result.primaryInitialPath,
		now: new Date("2026-05-07T01:00:00.000Z"),
	});

	const auditYml = await readFile(result.auditYmlPath, "utf8");
	assert.doesNotMatch(auditYml, /\\\\n/);
	const parsed = parseYamlSubset(auditYml);
	assert.match(parsed.target.git.status_short_branch, /\n/);
	assert.doesNotMatch(parsed.target.git.status_short_branch, /\\n/);
});

test("record-stage preserves escaped quotes before hash characters", async () => {
	const projectRoot = await createGitProject();
	await writeText(path.join(projectRoot, ".claude/audit/profiles/commit.yaml"), [
		"name: commit",
		"type: commit",
		"fragments:",
		"  - prompts/base.md",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Base\n");
	const target = 'quote " # not comment';

	const result = await startAudit({
		projectRoot,
		profile: "commit",
		target,
		auditId: "quote-hash-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	await writeText(result.primaryInitialPath, "# Primary audit\n");
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "primary",
		artifactPath: result.primaryInitialPath,
		now: new Date("2026-05-07T01:00:00.000Z"),
	});

	const parsed = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(parsed.target.raw, target);
});

test("prefers neutral profiles and neutral local overrides with provenance", async () => {
	const projectRoot = await createGitProject("audit-flow-neutral-");
	await writeText(path.join(projectRoot, ".audit/profiles/platform.yaml"), [
		"name: platform",
		"type: platform",
		"fragments:",
		"  - prompts/base.md",
		"platform:",
		"  name: ExamplePlatform",
		"  context_root: profile-context",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, ".audit/prompts/base.md"), "# Neutral profile\n");
	await writeText(path.join(projectRoot, ".claude/audit/profiles/platform.yaml"), [
		"name: platform",
		"type: platform",
		"fragments:",
		"  - prompts/base.md",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Legacy profile\n");
	await writeText(path.join(projectRoot, ".audit/local/audit.overrides.yaml"), [
		"platforms:",
		"  ExamplePlatform:",
		"    context_root: neutral-override",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, ".claude/local/audit.overrides.yaml"), [
		"platforms:",
		"  ExamplePlatform:",
		"    context_root: legacy-override",
		"",
	].join("\n"));

	const result = await startAudit({
		projectRoot,
		profile: "platform",
		auditId: "neutral-precedence",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});

	assert.equal(result.auditDir, path.join(projectRoot, ".audit/local/audits/neutral-precedence"));
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(metadata.profile.source, "repo-neutral");
	assert.equal(metadata.profile.config_root, ".audit");
	assert.equal(metadata.profile.local_override_source, "neutral");
	assert.deepEqual(metadata.profile.local_overrides, [".audit/local/audit.overrides.yaml"]);
	assert.equal(metadata.profile.platform.context_root, "neutral-override");
	assert.equal(metadata.artifacts.root_source, "neutral-default");
	const prompt = await readFile(result.primaryPromptPath, "utf8");
	assert.match(prompt, /# Neutral profile/);
	assert.doesNotMatch(prompt, /# Legacy profile/);
});

test("honors direct profile, explicit config root, profile artifact, and CLI artifact precedence", async () => {
	const projectRoot = await createGitProject("audit-flow-explicit-");
	await addGitCommit(projectRoot);
	await writeText(path.join(projectRoot, ".audit/profiles/pr.yaml"), [
		"name: neutral-pr",
		"type: pr",
		"base: HEAD~1",
		"head: HEAD",
		"fragments:",
		"  - prompts/base.md",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, ".audit/prompts/base.md"), "# Neutral\n");
	await writeText(path.join(projectRoot, "custom/profiles/pr.yaml"), [
		"name: explicit-pr",
		"type: pr",
		"base: HEAD~1",
		"head: HEAD",
		"fragments:",
		"  - prompts/base.md",
		"artifact_root:",
		"  path: profile-artifacts",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, "custom/prompts/base.md"), "# Explicit config\n");

	const configured = await startAudit({
		projectRoot,
		profile: "pr",
		auditConfigRoot: "custom",
		auditId: "explicit-config",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	assert.equal(configured.auditDir, path.join(projectRoot, "profile-artifacts/explicit-config"));
	assert.equal(configured.artifactRootSource, "profile");
	let metadata = parseYamlSubset(await readFile(configured.auditYmlPath, "utf8"));
	assert.equal(metadata.profile.name, "explicit-pr");
	assert.equal(metadata.profile.source, "explicit-config-root");
	assert.equal(metadata.profile.config_root, "custom");

	await writeText(path.join(projectRoot, "direct/profile.yaml"), [
		"name: direct-profile",
		"type: commit",
		"fragments:",
		"  - base.md",
		"artifact_root:",
		"  path: ignored-profile-artifacts",
		"",
	].join("\n"));
	await writeText(path.join(projectRoot, "direct/base.md"), "# Direct profile\n");
	const direct = await startAudit({
		projectRoot,
		profile: "direct/profile.yaml",
		auditConfigRoot: "custom",
		artifactRoot: "cli-artifacts",
		auditId: "direct-cli",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	assert.equal(direct.auditDir, path.join(projectRoot, "cli-artifacts/direct-cli"));
	assert.equal(direct.artifactRootSource, "cli");
	metadata = parseYamlSubset(await readFile(direct.auditYmlPath, "utf8"));
	assert.equal(metadata.profile.name, "direct-profile");
	assert.equal(metadata.profile.source, "direct");
});

test("rejects invalid audit IDs and collisions without reusing an audit directory", async () => {
	const projectRoot = await createGitProject("audit-flow-collision-");
	await assert.rejects(
		() => startAudit({ projectRoot, profile: "diff", auditId: "../escape", env: {} }),
		/Invalid audit ID/,
	);

	const first = await startAudit({
		projectRoot,
		profile: "diff",
		auditId: "same-id",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	const originalMetadata = await readFile(first.auditYmlPath, "utf8");
	await assert.rejects(
		() => startAudit({
			projectRoot,
			profile: "diff",
			auditId: "same-id",
			now: new Date("2026-05-08T00:00:00.000Z"),
			env: {},
		}),
		/Audit ID collision/,
	);
	assert.equal(await readFile(first.auditYmlPath, "utf8"), originalMetadata);
});

test("rejects symbolic-link components in config and artifact paths", async () => {
	const externalConfig = await mkdtemp(path.join(tmpdir(), "audit-flow-external-config-"));
	await writeText(path.join(externalConfig, "profiles/commit.yaml"), [
		"name: commit",
		"type: commit",
		"fragments:",
		"  - prompts/base.md",
		"",
	].join("\n"));
	await writeText(path.join(externalConfig, "prompts/base.md"), "# External\n");
	const configProject = await mkdtemp(path.join(tmpdir(), "audit-flow-symlink-config-"));
	await symlink(externalConfig, path.join(configProject, ".audit"), "dir");
	await assert.rejects(
		() => startAudit({ projectRoot: configProject, profile: "commit", auditId: "config-link", env: {} }),
		/symbolic-link component/,
	);

	const artifactProject = await mkdtemp(path.join(tmpdir(), "audit-flow-symlink-artifact-"));
	await initGitRepo(artifactProject);
	const externalArtifacts = await mkdtemp(path.join(tmpdir(), "audit-flow-external-artifacts-"));
	await symlink(externalArtifacts, path.join(artifactProject, "artifact-link"), "dir");
	await assert.rejects(
		() => startAudit({
			projectRoot: artifactProject,
			profile: "diff",
			artifactRoot: "artifact-link",
			auditId: "artifact-link",
			env: {},
		}),
		/symbolic-link component/,
	);
});

test("records focused finding verifiers and confines their artifacts", async () => {
	const projectRoot = await createGitProject("audit-flow-verifier-");
	const result = await startAudit({
		projectRoot,
		profile: "diff",
		auditId: "verifier-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	await writeText(result.primaryInitialPath, "# Primary\n");
	await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" });
	await writeText(result.peerReviewPath, "# Peer\n");
	await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "peer" });
	await writeText(path.join(result.auditDir, "verification-peer-only.md"), "# Verification\n");
	await assert.rejects(
		() => recordAuditStageRaw({
			auditYmlPath: result.auditYmlPath,
			stage: "verification",
			reviewerKey: "missing-prompt",
			artifactPath: "verification-peer-only.md",
			tool: "tool",
			model: "model",
			sessionId: "missing-prompt-session",
		}),
		/require --prompt/,
	);
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "verification",
		reviewerKey: "verifier-peer-only",
		artifactPath: "verification-peer-only.md",
		scope: "peer-only findings",
		tool: "claude-subagent",
		model: "test-model",
	});

	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(metadata.reviewers["verifier-peer-only"].role, "finding-verifier");
	assert.equal(metadata.reviewers["verifier-peer-only"].artifact, "verification-peer-only.md");
	assert.equal(metadata.reviewers["verifier-peer-only"].prompt, "verification-verifier-peer-only-prompt.md");
	assert.match(metadata.reviewers["verifier-peer-only"].prompt_sha256, /^[a-f0-9]{64}$/);
	assert.equal(
		metadata.reviewers["verifier-peer-only"].attestation.prompt_sha256,
		metadata.reviewers["verifier-peer-only"].prompt_sha256,
	);
	assert.equal(metadata.reviewers["verifier-peer-only"].scope, "peer-only findings");
	assert.equal(metadata.artifacts.verifier_peer_only, "verification-peer-only.md");
	assert.equal(metadata.artifacts.verifier_peer_only_prompt, "verification-verifier-peer-only-prompt.md");
	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "verification",
			reviewerKey: "verifier-peer-only",
			artifactPath: "verification-peer-only.md",
		}),
		/reviewer key collision/,
	);
	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "verification",
			reviewerKey: "second-verifier",
			artifactPath: "verification-peer-only.md",
		}),
		/already recorded by another reviewer/,
	);
	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "verification",
			reviewerKey: "primary",
			artifactPath: "verification-peer-only.md",
		}),
		/reviewer key collision/,
	);

	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "verification" }),
		/require --reviewer-key/,
	);
	const outsideRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-outside-"));
	await writeText(path.join(outsideRoot, "verification-outside.md"), "# Outside\n");
	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "verification",
			reviewerKey: "outside-verifier",
			artifactPath: path.join(outsideRoot, "verification-outside.md"),
		}),
		/must be inside the selected audit directory/,
	);
	await writeText(path.join(result.auditDir, "wrong-name.md"), "# Wrong name\n");
	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "verification",
			reviewerKey: "wrong-name-verifier",
			artifactPath: "wrong-name.md",
		}),
		/filename must match verification-<name>\.md/,
	);
	await writeText(path.join(result.auditDir, "real-verification.md"), "# Real\n");
	await symlink("real-verification.md", path.join(result.auditDir, "verification-linked.md"));
	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "verification",
			reviewerKey: "linked-verifier",
			artifactPath: "verification-linked.md",
		}),
		/symbolic-link component/,
	);
});

test("binds exact staged, unstaged, and ordered untracked repository state", async () => {
	const projectRoot = await createGitProject("audit-flow-snapshot-");
	await writeFile(path.join(projectRoot, "tracked.bin"), Buffer.from([0, 1, 2]));
	await execFileAsync("git", ["add", "tracked.bin"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "tracked"], {
		cwd: projectRoot,
	});
	await writeFile(path.join(projectRoot, "tracked.bin"), Buffer.from([0, 3, 4]));
	await execFileAsync("git", ["add", "tracked.bin"], { cwd: projectRoot });
	await writeFile(path.join(projectRoot, "tracked.bin"), Buffer.from([0, 3, 5]));
	await writeFile(path.join(projectRoot, "z-last.bin"), Buffer.from([255, 0, 7]));
	await writeText(path.join(projectRoot, "a-first.sh"), "#!/bin/sh\nexit 0\n");
	await chmod(path.join(projectRoot, "a-first.sh"), 0o755);
	await symlink("a-first.sh", path.join(projectRoot, "m-link"));

	const result = await startAudit({
		projectRoot,
		profile: "diff",
		auditId: "snapshot-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(metadata.target.snapshot_schema, "git-worktree-v2");
	assert.match(metadata.target.snapshot_sha256, /^[a-f0-9]{64}$/);
	assert.equal(metadata.target.repos.length, 1);
	const repo = metadata.target.repos[0];
	assert.equal(repo.base_ref, "HEAD");
	assert.equal(repo.head_ref, "HEAD");
	assert.equal(repo.base_oid, repo.head_oid);
	const trackedBinary = repo.tracked.find((entry) => entry.path === "tracked.bin");
	assert.deepEqual(trackedBinary, {
		path: "tracked.bin",
		index_mode: "100644",
		index_oid: trackedBinary.index_oid,
		worktree_mode: "100644",
		sha256: sha256(Buffer.from([0, 3, 5])),
	});
	assert.match(trackedBinary.index_oid, /^[a-f0-9]{40,64}$/);
	assert.equal(repo.tracked_manifest_sha256, sha256(stableJson(repo.tracked)));
	assert.deepEqual(repo.untracked.map((entry) => [entry.path, entry.mode]), [
		["a-first.sh", "100755"],
		["m-link", "120000"],
		["z-last.bin", "100644"],
	]);
	assert.equal(repo.untracked[0].sha256, sha256("#!/bin/sh\nexit 0\n"));
	assert.equal(repo.untracked[1].sha256, sha256("a-first.sh"));
	assert.equal(repo.untracked[2].sha256, sha256(Buffer.from([255, 0, 7])));

	const staged = await execFileAsync("git", [
		"diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", repo.head_oid, "--",
	], { cwd: projectRoot, encoding: "buffer" });
	const unstaged = await execFileAsync("git", [
		"diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", "--",
	], { cwd: projectRoot, encoding: "buffer" });
	assert.equal(repo.staged_diff_sha256, sha256(staged.stdout));
	assert.equal(repo.unstaged_diff_sha256, sha256(unstaged.stdout));
	const { snapshot_sha256: _repoDigest, ...repoIdentity } = repo;
	assert.equal(metadata.target.snapshot_sha256, sha256(stableJson([repoIdentity])));
	assert.notEqual(metadata.target.snapshot_sha256, sha256(stableJson(metadata.target.repos)));

	await writeText(result.primaryInitialPath, "# Primary\n");
	await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" });
	await writeFile(path.join(projectRoot, "tracked.bin"), Buffer.from([0, 9, 9]));
	await writeText(result.peerReviewPath, "# Peer\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "peer" }),
		/Audit target snapshot changed/,
	);
	const afterDrift = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(afterDrift.reviewers.peer.completed_at, null);
});

for (const indexFlag of ["--assume-unchanged", "--skip-worktree"]) {
	test(`raw tracked snapshot detects byte drift hidden by ${indexFlag}`, async () => {
		const projectRoot = await createGitProject(`audit-flow-${indexFlag.slice(2)}-`);
		await writeText(path.join(projectRoot, "tracked.txt"), "before\n");
		await execFileAsync("git", ["add", "tracked.txt"], { cwd: projectRoot });
		await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "tracked"], {
			cwd: projectRoot,
		});
		const result = await startAudit({ projectRoot, profile: "diff", auditId: "flag-snapshot", env: {} });
		await execFileAsync("git", ["update-index", indexFlag, "tracked.txt"], { cwd: projectRoot });
		await writeText(path.join(projectRoot, "tracked.txt"), "bytes hidden from git diff\n");
		const hiddenDiff = await execFileAsync("git", ["diff", "--", "tracked.txt"], { cwd: projectRoot });
		assert.equal(hiddenDiff.stdout, "");
		await writeText(result.primaryInitialPath, "# Primary\n");
		await assert.rejects(
			() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
			/Audit target snapshot changed/,
		);
	});
}

test("raw tracked snapshot bypasses Git clean filters and binds symlink text and executable mode", async () => {
	const projectRoot = await createGitProject("audit-flow-raw-tracked-");
	await execFileAsync("git", ["config", "filter.audit-test.clean", "sed s/dirty/clean/g"], { cwd: projectRoot });
	await execFileAsync("git", ["config", "filter.audit-test.smudge", "cat"], { cwd: projectRoot });
	await writeText(path.join(projectRoot, ".gitattributes"), "filtered.txt filter=audit-test\n");
	await writeText(path.join(projectRoot, "filtered.txt"), "clean\n");
	await writeText(path.join(projectRoot, "mode.sh"), "#!/bin/sh\n");
	await symlink("filtered.txt", path.join(projectRoot, "tracked-link"));
	await execFileAsync("git", ["add", ".gitattributes", "filtered.txt", "mode.sh", "tracked-link"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "raw inputs"], {
		cwd: projectRoot,
	});
	const filtered = await startAudit({ projectRoot, profile: "diff", auditId: "filtered-snapshot", env: {} });
	await writeText(path.join(projectRoot, "filtered.txt"), "dirty\n");
	assert.equal((await execFileAsync("git", ["diff", "--", "filtered.txt"], { cwd: projectRoot })).stdout, "");
	await writeText(filtered.primaryInitialPath, "# Filtered\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: filtered.auditYmlPath, stage: "primary" }),
		/Audit target snapshot changed/,
	);

	await writeText(path.join(projectRoot, "filtered.txt"), "clean\n");
	const symlinkAudit = await startAudit({ projectRoot, profile: "diff", auditId: "symlink-snapshot", env: {} });
	await unlink(path.join(projectRoot, "tracked-link"));
	await symlink("mode.sh", path.join(projectRoot, "tracked-link"));
	await writeText(symlinkAudit.primaryInitialPath, "# Symlink\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: symlinkAudit.auditYmlPath, stage: "primary" }),
		/Audit target snapshot changed/,
	);

	await unlink(path.join(projectRoot, "tracked-link"));
	await symlink("filtered.txt", path.join(projectRoot, "tracked-link"));
	const modeAudit = await startAudit({ projectRoot, profile: "diff", auditId: "mode-snapshot", env: {} });
	await chmod(path.join(projectRoot, "mode.sh"), 0o755);
	await writeText(modeAudit.primaryInitialPath, "# Mode\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: modeAudit.auditYmlPath, stage: "primary" }),
		/Audit target snapshot changed/,
	);
});

test("raw tracked snapshot rejects a symlink substituted into a tracked path parent", async () => {
	const projectRoot = await createGitProject("audit-flow-parent-link-");
	await writeText(path.join(projectRoot, "tracked-dir/file.txt"), "inside\n");
	await execFileAsync("git", ["add", "tracked-dir/file.txt"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "nested tracked file"], {
		cwd: projectRoot,
	});
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "parent-link", env: {} });
	const externalRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-parent-link-external-"));
	await writeText(path.join(externalRoot, "file.txt"), "outside\n");
	await unlink(path.join(projectRoot, "tracked-dir/file.txt"));
	await rmdir(path.join(projectRoot, "tracked-dir"));
	await symlink(externalRoot, path.join(projectRoot, "tracked-dir"), "dir");
	await writeText(result.primaryInitialPath, "# Primary\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/symbolic-link parent component: tracked-dir\/file.txt/,
	);
});

test("tracked snapshot records regular-to-symlink worktree transitions and revalidates link text", async () => {
	const projectRoot = await createGitProject("audit-flow-regular-to-link-");
	await writeText(path.join(projectRoot, "entry"), "indexed regular bytes\n");
	await execFileAsync("git", ["add", "entry"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "regular entry"], {
		cwd: projectRoot,
	});
	await unlink(path.join(projectRoot, "entry"));
	await symlink("first-target", path.join(projectRoot, "entry"));

	const result = await startAudit({ projectRoot, profile: "diff", auditId: "regular-to-link", env: {} });
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	const entry = metadata.target.repos[0].tracked.find((candidate) => candidate.path === "entry");
	assert.equal(entry.index_mode, "100644");
	assert.equal(entry.index_oid, (await execFileAsync("git", ["rev-parse", "HEAD:entry"], { cwd: projectRoot })).stdout.trim());
	assert.equal(entry.worktree_mode, "120000");
	assert.equal(entry.sha256, sha256("first-target"));
	await assertTargetSnapshotUnchanged(metadata.target);

	await unlink(path.join(projectRoot, "entry"));
	await symlink("second-target", path.join(projectRoot, "entry"));
	await writeText(result.primaryInitialPath, "# Primary\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/Audit target snapshot changed/,
	);
});

test("tracked snapshot records symlink-to-regular worktree transitions and revalidates raw bytes", async () => {
	const projectRoot = await createGitProject("audit-flow-link-to-regular-");
	await symlink("indexed-target", path.join(projectRoot, "entry"));
	await execFileAsync("git", ["add", "entry"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "symlink entry"], {
		cwd: projectRoot,
	});
	await unlink(path.join(projectRoot, "entry"));
	await writeText(path.join(projectRoot, "entry"), "current regular bytes\n");

	const result = await startAudit({ projectRoot, profile: "diff", auditId: "link-to-regular", env: {} });
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	const entry = metadata.target.repos[0].tracked.find((candidate) => candidate.path === "entry");
	assert.equal(entry.index_mode, "120000");
	assert.equal(entry.index_oid, (await execFileAsync("git", ["rev-parse", "HEAD:entry"], { cwd: projectRoot })).stdout.trim());
	assert.equal(entry.worktree_mode, "100644");
	assert.equal(entry.sha256, sha256("current regular bytes\n"));
	await assertTargetSnapshotUnchanged(metadata.target);

	await writeText(path.join(projectRoot, "entry"), "changed regular bytes\n");
	await writeText(result.primaryInitialPath, "# Primary\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/Audit target snapshot changed/,
	);
});

test("tracked snapshot records symlink-to-executable transitions and revalidates mode", async () => {
	const projectRoot = await createGitProject("audit-flow-link-to-executable-");
	await symlink("indexed-target", path.join(projectRoot, "entry"));
	await execFileAsync("git", ["add", "entry"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "symlink entry"], {
		cwd: projectRoot,
	});
	await unlink(path.join(projectRoot, "entry"));
	await writeText(path.join(projectRoot, "entry"), "#!/bin/sh\n");
	await chmod(path.join(projectRoot, "entry"), 0o755);

	const result = await startAudit({ projectRoot, profile: "diff", auditId: "link-to-executable", env: {} });
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	const entry = metadata.target.repos[0].tracked.find((candidate) => candidate.path === "entry");
	assert.equal(entry.index_mode, "120000");
	assert.equal(entry.index_oid, (await execFileAsync("git", ["rev-parse", "HEAD:entry"], { cwd: projectRoot })).stdout.trim());
	assert.equal(entry.worktree_mode, "100755");
	assert.equal(entry.sha256, sha256("#!/bin/sh\n"));
	await assertTargetSnapshotUnchanged(metadata.target);

	await chmod(path.join(projectRoot, "entry"), 0o644);
	await writeText(result.primaryInitialPath, "# Primary\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/Audit target snapshot changed/,
	);
});

test("tracked gitlinks fail closed with an explicit separate-repository policy", async () => {
	const projectRoot = await createGitProject("audit-flow-gitlink-");
	const oid = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim();
	await execFileAsync("git", ["update-index", "--add", "--cacheinfo", `160000,${oid},nested-repo`], { cwd: projectRoot });
	await assert.rejects(
		() => startAudit({ projectRoot, profile: "diff", auditId: "gitlink-audit", env: {} }),
		/do not traverse tracked submodules.*Select the submodule as a separate profile repository/,
	);
});

test("captures ordered multi-repo snapshots with ref precedence", async () => {
	const platformRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-multi-"));
	for (const name of ["api", "web"]) {
		const repoRoot = path.join(platformRoot, name);
		await initGitRepo(repoRoot);
		await writeText(path.join(repoRoot, "second.txt"), `${name}\n`);
		await execFileAsync("git", ["add", "second.txt"], { cwd: repoRoot });
		await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "second"], {
			cwd: repoRoot,
		});
	}
	const profilePath = path.join(platformRoot, ".audit/profiles/platform.yaml");
	const profileText = [
		"name: platform",
		"type: platform",
		"base: HEAD",
		"fragments:",
		"  - prompts/base.md",
		"platform:",
		"  name: Example",
		"  context_root: .",
		"repos:",
		"  - name: api",
		"    role: api \"quoted\" role",
		"    path: api",
		"    base: HEAD~1",
		"    head: HEAD",
		"  - name: web",
		"    path: web",
		"artifact_root:",
		"  repo: api",
		"  path: .audit/local/audits",
		"",
	].join("\n");
	await writeText(profilePath, profileText);
	await writeText(path.join(platformRoot, ".audit/prompts/base.md"), "# Multi\n");

	const result = await startAudit({
		projectRoot: platformRoot,
		profile: "platform",
		base: "HEAD~1",
		head: "HEAD",
		auditId: "multi-audit",
		env: {},
	});
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.deepEqual(metadata.target.repos.map((repo) => repo.name), ["api", "web"]);
	assert.deepEqual(metadata.target.repos.map((repo) => repo.role), ["api \"quoted\" role", null]);
	assert.deepEqual(metadata.target.repos.map((repo) => repo.base_ref), ["HEAD~1", "HEAD~1"]);
	assert.deepEqual(metadata.target.repos.map((repo) => repo.head_ref), ["HEAD", "HEAD"]);
	assert.notEqual(metadata.target.repos[0].base_oid, metadata.target.repos[0].head_oid);

	const prompts = await Promise.all([
		readFile(result.primaryPromptPath, "utf8"),
		readFile(result.peerPromptPath, "utf8"),
		readFile(result.finalDiffPromptPath, "utf8"),
	]);
	for (const prompt of prompts) {
		assert.ok(prompt.includes(`Target snapshot schema: \`${metadata.target.snapshot_schema}\``));
		assert.ok(prompt.includes(`Aggregate snapshot SHA-256: \`${metadata.target.snapshot_sha256}\``));
		assert.doesNotMatch(prompt, /"tracked":|"untracked":/);
		assert.deepEqual(promptSnapshotRecords(prompt), promptSnapshotRecords(prompts[0]));
	}
	assert.doesNotMatch(prompts[1], /# Multi|primary-initial\.md/);
	assert.ok(!prompts[1].includes(result.auditDir));

	const disclosed = promptSnapshotRecords(prompts[0]);
	assert.deepEqual(disclosed.map((entry) => entry.capture.role), ["api \"quoted\" role", null]);
	assert.deepEqual(disclosed.map((entry) => entry.capture.path), metadata.target.repos.map((repo) => repo.root));
	assert.deepEqual(disclosed.map((entry) => entry.resolved), metadata.target.repos.map(resolvedPromptIdentity));
	const replayed = await captureTargetSnapshot({
		projectRoot: disclosed[0].capture.path,
		profile: {
			repos: disclosed.map(({ capture }) => ({
				name: capture.name,
				role: capture.role,
				path: capture.path,
				base: capture.base_ref,
				head: capture.head_ref,
			})),
		},
	});
	assert.equal(replayed.snapshot_sha256, metadata.target.snapshot_sha256);
	assert.deepEqual(replayed.repos.map(resolvedPromptIdentity), disclosed.map((entry) => entry.resolved));

	await writeText(profilePath, profileText.replace("api \"quoted\" role", "changed-role"));
	const changedRole = await startAudit({
		projectRoot: platformRoot,
		profile: "platform",
		base: "HEAD~1",
		head: "HEAD",
		auditId: "multi-audit-role-change",
		env: {},
	});
	const changedMetadata = parseYamlSubset(await readFile(changedRole.auditYmlPath, "utf8"));
	assert.notEqual(changedMetadata.target.repos[0].snapshot_sha256, metadata.target.repos[0].snapshot_sha256);
	assert.notEqual(changedMetadata.target.snapshot_sha256, metadata.target.snapshot_sha256);
	const changedPrompt = await readFile(changedRole.primaryPromptPath, "utf8");
	assert.notEqual(changedPrompt, prompts[0]);
	assert.equal(changedMetadata.reviewers.primary.prompt_sha256, sha256(changedPrompt));
	assert.notEqual(changedMetadata.reviewers.primary.prompt_sha256, metadata.reviewers.primary.prompt_sha256);
});

test("records immutable reviewer runs and enforces the distinct final-diff gate", async () => {
	const projectRoot = await createGitProject("audit-flow-final-diff-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "final-diff-audit", env: {} });
	const initial = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	const dispatchIds = [
		initial.reviewers.primary.dispatch_id,
		initial.reviewers.peer.dispatch_id,
		initial.reviewers.final_diff.dispatch_id,
	];
	assert.equal(new Set(dispatchIds).size, 3);
	assert.match(initial.reviewers.primary.prompt_sha256, /^[a-f0-9]{64}$/);
	assert.match(initial.reviewers.peer.prompt_sha256, /^[a-f0-9]{64}$/);
	assert.match(initial.reviewers.final_diff.prompt_sha256, /^[a-f0-9]{64}$/);
	const peerPrompt = await readFile(result.peerPromptPath, "utf8");
	assert.doesNotMatch(peerPrompt, /primary-initial|Primary audit artifact/);
	const finalPrompt = await readFile(result.finalDiffPromptPath, "utf8");
	assert.match(finalPrompt, /fresh adversarial review of the entire bound diff/);
	assert.match(finalPrompt, /Do not treat this stage as verification/);

	await writeText(result.primaryInitialPath, "");
	await writeText(result.peerReviewPath, "# Blind peer report\n");
	await writeText(result.finalDiffReviewPath, "# Final diff report\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "peer" }),
		/requires a completed primary stage/,
	);
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "final-diff" }),
		/requires completed primary and blind peer stages/,
	);
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/artifact must not be empty/,
	);
	await writeText(result.primaryInitialPath, "# Primary report\n");
	await assert.rejects(
		() => recordAuditStageRaw({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/requires a nonempty tool/,
	);
	await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary", tool: "claude-subagent" });
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/refusing to overwrite reviewer provenance/,
	);
	await writeText(result.peerReviewPath, "# Primary report\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "peer", tool: "external-peer" }),
		/byte-identical to an already-recorded reviewer report/,
	);
	await writeText(result.peerReviewPath, "# Blind peer report\n");
	await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "peer", tool: "external-peer" });
	await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "final-diff", tool: "claude-subagent" });
	const recorded = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(recorded.reviewers.primary.report_sha256, sha256("# Primary report\n"));
	assert.equal(recorded.reviewers.peer.report_sha256, sha256("# Blind peer report\n"));
	assert.equal(recorded.reviewers.final_diff.report_sha256, sha256("# Final diff report\n"));
	assert.deepEqual(recorded.reviewers.primary.attestation, {
		kind: "orchestrator-attested",
		audit_id: recorded.id,
		reviewer_key: "primary",
		dispatch_id: recorded.reviewers.primary.dispatch_id,
		target_snapshot_sha256: recorded.target.snapshot_sha256,
		prompt_sha256: recorded.reviewers.primary.prompt_sha256,
		artifact: "primary-initial.md",
		report_sha256: recorded.reviewers.primary.report_sha256,
		recorded_at: recorded.reviewers.primary.completed_at,
	});
});

test("refuses altered prompts and serializes concurrent reviewer metadata updates", async () => {
	const projectRoot = await createGitProject("audit-flow-integrity-");
	const tampered = await startAudit({ projectRoot, profile: "diff", auditId: "prompt-tamper", env: {} });
	await writeText(tampered.primaryInitialPath, "# Primary\n");
	await writeText(tampered.primaryPromptPath, "altered prompt\n");
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: tampered.auditYmlPath, stage: "primary" }),
		/prompt digest mismatch/,
	);

	const concurrent = await startAudit({ projectRoot, profile: "diff", auditId: "concurrent-record", env: {} });
	await writeText(concurrent.primaryInitialPath, "# Concurrent primary\n");
	await recordAuditStage({ auditYmlPath: concurrent.auditYmlPath, stage: "primary" });
	await writeText(concurrent.peerReviewPath, "# Concurrent peer\n");
	await recordAuditStage({ auditYmlPath: concurrent.auditYmlPath, stage: "peer" });
	await writeText(path.join(concurrent.auditDir, "verification-one.md"), "# One\n");
	await writeText(path.join(concurrent.auditDir, "verification-two.md"), "# Two\n");
	await Promise.all([
		recordAuditStage({
			auditYmlPath: concurrent.auditYmlPath,
			stage: "verification",
			reviewerKey: "verifier-one",
			artifactPath: "verification-one.md",
		}),
		recordAuditStage({
			auditYmlPath: concurrent.auditYmlPath,
			stage: "verification",
			reviewerKey: "verifier-two",
			artifactPath: "verification-two.md",
		}),
	]);
	const metadata = parseYamlSubset(await readFile(concurrent.auditYmlPath, "utf8"));
	assert.ok(metadata.reviewers["verifier-one"].completed_at);
	assert.ok(metadata.reviewers["verifier-two"].completed_at);
	assert.notEqual(
		metadata.reviewers["verifier-one"].dispatch_id,
		metadata.reviewers["verifier-two"].dispatch_id,
	);
});

test("strict finalization validates snapshots, stages, and artifact digests", async () => {
	const projectRoot = await createGitProject("audit-flow-finalize-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "finalize-audit", env: {} });
	const reports = [
		["primary", result.primaryInitialPath, "# Primary\n"],
		["peer", result.peerReviewPath, "# Peer\n"],
		["final-diff", result.finalDiffReviewPath, "# Final diff\n"],
	];
	for (const [stage, artifact, contents] of reports) {
		await writeText(artifact, contents);
		await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage });
	}
	await writeText(result.findingsPath, "[]\n");
	await writeText(result.receiptPath, "# Receipt\n\nNo confirmed findings.\n");
	await writeText(path.join(projectRoot, ".audit-test-seed"), "drift\n");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/Audit target snapshot changed/,
	);
	await writeText(path.join(projectRoot, ".audit-test-seed"), "seed\n");
	await writeText(result.peerReviewPath, "tampered peer report\n");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/peer report SHA-256 does not match/,
	);
	await writeText(result.peerReviewPath, "# Peer\n");
	await finalizeAudit({
		auditYmlPath: result.auditYmlPath,
		status: "passed",
		now: new Date("2026-05-07T03:00:00.000Z"),
	});
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(metadata.status, "passed");
	assert.equal(metadata.finalized_at, "2026-05-07T03:00:00.000Z");
	assert.deepEqual(metadata.finalization.required_stages, ["primary", "peer", "final_diff"]);
	assert.equal(metadata.finalization.target_snapshot_sha256, metadata.target.snapshot_sha256);
	assert.equal(metadata.finalization.findings_sha256, sha256("[]\n"));
	assert.equal(metadata.finalization.receipt_sha256, sha256("# Receipt\n\nNo confirmed findings.\n"));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/already finalized/,
	);
	await assert.rejects(
		() => recordAuditStage({ auditYmlPath: result.auditYmlPath, stage: "primary" }),
		/finalized or not in progress/,
	);
});

test("fixed stages reject alternate artifacts and duplicate nonempty session IDs", async () => {
	const projectRoot = await createGitProject("audit-flow-stage-identity-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "stage-identity", env: {} });
	await writeText(result.primaryInitialPath, "# Primary\n");
	await writeText(result.peerReviewPath, "# Peer\n");
	await writeText(path.join(result.auditDir, "alternate-primary.md"), "# Alternate\n");

	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "primary",
			artifactPath: "alternate-primary.md",
		}),
		/artifact must match the dispatched metadata path/,
	);
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "primary",
		sessionId: "shared-session",
	});
	await assert.rejects(
		() => recordAuditStage({
			auditYmlPath: result.auditYmlPath,
			stage: "peer",
			sessionId: "shared-session",
		}),
		/Reviewer session IDs must be distinct/,
	);
	let metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(metadata.reviewers.peer.completed_at, null);
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "peer",
		sessionId: "peer-session",
	});
	metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(metadata.reviewers.primary.session_id, "shared-session");
	assert.equal(metadata.reviewers.peer.session_id, "peer-session");
});

test("finalization rejects duplicate recorded session IDs", async () => {
	const projectRoot = await createGitProject("audit-flow-final-session-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "final-session", env: {} });
	for (const [stage, artifact, sessionId] of [
		["primary", result.primaryInitialPath, "primary-session"],
		["peer", result.peerReviewPath, "peer-session"],
		["final-diff", result.finalDiffReviewPath, "final-session"],
	]) {
		await writeText(artifact, `# ${stage}\n`);
		await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage, sessionId });
	}
	await writeText(result.findingsPath, "[]\n");
	await writeText(result.receiptPath, "# Receipt\n");
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	metadata.reviewers.peer.session_id = metadata.reviewers.primary.session_id;
	await writeFile(result.auditYmlPath, toYaml(metadata), "utf8");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/Reviewer session IDs must be distinct/,
	);
});

test("finalization requires fixed prompt provenance, run identity, structural attestation, and distinct reports", async () => {
	const projectRoot = await createGitProject("audit-flow-final-provenance-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "final-provenance", env: {} });
	await recordRequiredStages(result, "Provenance");
	await writeText(result.findingsPath, "[]\n");
	await writeText(result.receiptPath, "# Receipt\n");
	const baseline = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));

	let altered = structuredClone(baseline);
	delete altered.reviewers.primary.prompt;
	delete altered.reviewers.primary.prompt_sha256;
	await writeFile(result.auditYmlPath, toYaml(altered), "utf8");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/prompt does not match the dispatched metadata path/,
	);

	altered = structuredClone(baseline);
	altered.reviewers.peer.model = "";
	await writeFile(result.auditYmlPath, toYaml(altered), "utf8");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/peer reviewer has no nonempty model/,
	);

	altered = structuredClone(baseline);
	altered.reviewers.final_diff.attestation.target_snapshot_sha256 = "0".repeat(64);
	await writeFile(result.auditYmlPath, toYaml(altered), "utf8");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/final_diff attestation target_snapshot_sha256 does not match/,
	);

	altered = structuredClone(baseline);
	altered.reviewers.peer.report_sha256 = altered.reviewers.primary.report_sha256;
	await writeFile(result.auditYmlPath, toYaml(altered), "utf8");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/Required reviewer report hashes must be distinct/,
	);
});

test("finalization rejects reserved YAML keys before reviewer lookup", async () => {
	const projectRoot = await createGitProject("audit-flow-reserved-yaml-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "reserved-yaml", env: {} });
	await recordRequiredStages(result, "Reserved YAML");
	await writeText(result.findingsPath, "[]\n");
	await writeText(result.receiptPath, "# Receipt\n");
	const original = await readFile(result.auditYmlPath, "utf8");
	await writeText(result.auditYmlPath, original.replace(
		"reviewers:\n",
		["reviewers:", "  __proto__:", "    inherited:", "      role: finding-verifier", ""].join("\n"),
	));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/reserved YAML mapping key.*__proto__/,
	);
});

test("finalization binds fixed reports to dispatched artifact metadata", async () => {
	const projectRoot = await createGitProject("audit-flow-report-binding-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "report-binding", env: {} });
	await recordRequiredStages(result, "Report binding");
	await writeText(result.findingsPath, "[]\n");
	await writeText(result.receiptPath, "# Receipt\n");
	const alternateArtifact = "alternate-primary.md";
	const alternateContents = "# Alternate primary report\n";
	await writeText(path.join(result.auditDir, alternateArtifact), alternateContents);
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	const alternateDigest = sha256(alternateContents);
	metadata.reviewers.primary.artifact = alternateArtifact;
	metadata.reviewers.primary.report_sha256 = alternateDigest;
	metadata.reviewers.primary.attestation.artifact = alternateArtifact;
	metadata.reviewers.primary.attestation.report_sha256 = alternateDigest;
	await writeText(result.auditYmlPath, toYaml(metadata));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/primary report does not match the dispatched metadata path/,
	);
});

test("finalization rejects a hand-edited supplemental timestamp before peer completion", async () => {
	const projectRoot = await createGitProject("audit-flow-supplemental-time-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "supplemental-time", env: {} });
	await recordRequiredStages(result, "Timestamp");
	await writeText(path.join(result.auditDir, "verification-time.md"), "# Verification timestamp\n");
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "verification",
		reviewerKey: "time-verifier",
		artifactPath: "verification-time.md",
	});
	await writeText(result.findingsPath, "[]\n");
	await writeText(result.receiptPath, "# Receipt\n");
	const metadata = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	const early = new Date(Date.parse(metadata.reviewers.peer.completed_at) - 1).toISOString();
	metadata.reviewers["time-verifier"].completed_at = early;
	metadata.reviewers["time-verifier"].attestation.recorded_at = early;
	await writeText(result.auditYmlPath, toYaml(metadata));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/Supplemental reviewer time-verifier must not complete before primary and peer/,
	);
});

test("finding provenance rejects byte-identical cited reports", async () => {
	const projectRoot = await createGitProject("audit-flow-copy-defense-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "copy-defense", env: {} });
	await recordRequiredStages(result, "Copy defense");
	const primary = await readFile(result.primaryInitialPath, "utf8");
	await writeText(path.join(result.auditDir, "verification-copy.md"), primary);
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "verification",
		reviewerKey: "copy-verifier",
		artifactPath: "verification-copy.md",
	});
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-COPY",
		status: "fixed",
		source: ["primary", "copy-verifier"],
		verification: { required: 2, artifacts: ["primary-initial.md", "verification-copy.md"] },
	}] }));
	await writeText(result.receiptPath, "# Receipt\n");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/cites byte-identical reviewer reports/,
	);
});

test("finalization enforces finding shape, reviewer gate, and status policy", async () => {
	const projectRoot = await createGitProject("audit-flow-finding-gate-");
	const result = await startAudit({ projectRoot, profile: "diff", auditId: "finding-gate", env: {} });
	for (const [stage, artifact] of [
		["primary", result.primaryInitialPath],
		["peer", result.peerReviewPath],
		["final-diff", result.finalDiffReviewPath],
	]) {
		await writeText(artifact, `# ${stage}\n`);
		await recordAuditStage({ auditYmlPath: result.auditYmlPath, stage });
	}
	await writeText(result.receiptPath, "# Receipt\n");

	await writeText(result.findingsPath, "{}\n");
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/array or an object with a findings array/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-MISSING-STATUS",
		source: ["primary", "peer"],
		verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "blocked" }),
		/invalid or missing status: missing/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-UNKNOWN-STATUS",
		status: "invented",
		source: ["primary", "peer"],
		verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "blocked" }),
		/invalid or missing status: invented/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-GENERIC-ROLES",
		status: "fixed",
		source: ["primary-reviewer", "peer-reviewer"],
		verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/cites reviewer key without a completed recorded report: primary-reviewer/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-MISSING-ARTIFACT-BINDING",
		status: "fixed",
		source: ["primary", "peer"],
		verification: { required: 2, artifacts: ["primary-initial.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/does not include the report recorded for reviewer key peer/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-001",
		status: "fixed",
		source: ["primary"],
		verification: { required: 2, artifacts: ["primary-initial.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed_with_deferred" }),
		/has not passed its 2-reviewer finding verification gate/,
	);
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "blocked" }),
		/has not passed its 2-reviewer finding verification gate/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-002",
		status: "fixed",
		source: ["primary", "missing-reviewer"],
		verification: { required: 2, artifacts: ["primary-initial.md", "missing.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/cites reviewer key without a completed recorded report/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-003",
		status: "accepted",
		source: ["primary", "peer"],
		verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed_with_deferred" }),
		/is unresolved \(accepted\); final status must be blocked/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [{
		id: "F-NO-DEFERRED",
		status: "fixed",
		source: ["primary", "peer"],
		verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
	}] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed_with_deferred" }),
		/requires at least one deferred finding/,
	);

	await writeText(result.findingsPath, JSON.stringify({ findings: [
		{
			id: "F-004",
			status: "fixed",
			source: ["primary", "peer"],
			verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
		},
		{
			id: "F-005",
			status: "deferred",
			source: ["primary"],
			verification: { required: 2, artifacts: ["primary-initial.md"] },
		},
	] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed_with_deferred" }),
		/has not passed its 2-reviewer finding verification gate/,
	);
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "blocked" }),
		/has not passed its 2-reviewer finding verification gate/,
	);
	await writeText(result.findingsPath, JSON.stringify({ findings: [
		{
			id: "F-004",
			status: "fixed",
			source: ["primary", "peer"],
			verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
		},
		{
			id: "F-005",
			status: "deferred",
			source: ["primary", "peer"],
			verification: { required: 2, artifacts: ["primary-initial.md", "peer-review.md"] },
		},
	] }));
	await assert.rejects(
		() => finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed" }),
		/is deferred; use passed_with_deferred or blocked/,
	);
	await finalizeAudit({ auditYmlPath: result.auditYmlPath, status: "passed_with_deferred" });
	const finalized = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(finalized.status, "passed_with_deferred");
});
