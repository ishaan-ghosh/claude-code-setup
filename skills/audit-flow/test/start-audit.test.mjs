import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { parseYamlSubset, startAudit } from "../scripts/start-audit.mjs";

const execFileAsync = promisify(execFile);

async function writeText(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents, "utf8");
}

test("creates an audit workspace from a profile and prompt fragments", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
	await writeText(
		path.join(projectRoot, ".claude/audit/profiles/pr.yaml"),
		[
			"name: pr",
			"description: Pull request audit",
			"type: pr",
			"fragments:",
			"  - prompts/base.md",
			"  - prompts/output-format.md",
			"",
		].join("\n"),
	);
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Base\n\nAudit concrete regressions.\n");
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

	const primaryPrompt = await readFile(result.primaryPromptPath, "utf8");
	assert.match(primaryPrompt, /You are the primary-reviewer/);
	assert.match(primaryPrompt, /Target: PR #42/);
	assert.match(primaryPrompt, /# Base/);
	assert.match(primaryPrompt, /Audit concrete regressions/);
	assert.match(primaryPrompt, /# Output/);
	assert.match(primaryPrompt, /Do not edit application code/);

	const peerPrompt = await readFile(result.peerPromptPath, "utf8");
	assert.match(peerPrompt, /You are the peer-reviewer/);
	assert.match(peerPrompt, /primary-initial\.md/);
	assert.match(peerPrompt, /Do not edit application code/);
});

test("records portable platform metadata with local path overrides", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
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
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
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

test("refuses to write default local artifacts inside a git repo unless the path is ignored", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
	await execFileAsync("git", ["init"], { cwd: projectRoot });
	await writeText(
		path.join(projectRoot, ".claude/audit/profiles/commit.yaml"),
		[
			"name: commit",
			"type: commit",
			"fragments:",
			"  - prompts/base.md",
			"",
		].join("\n"),
	);
	await writeText(path.join(projectRoot, ".claude/audit/prompts/base.md"), "# Base\n");

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

	await writeText(path.join(projectRoot, ".gitignore"), ".claude/local/\n");
	const result = await startAudit({
		projectRoot,
		profile: "commit",
		auditId: "safe-audit",
		now: new Date("2026-05-07T00:00:00.000Z"),
		env: {},
	});

	assert.equal(result.auditDir, path.join(projectRoot, ".claude/local/audits/safe-audit"));
});

test("falls back to built-in profiles when a repo has no local audit profile", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));

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

	const primaryPrompt = await readFile(result.primaryPromptPath, "utf8");
	assert.match(primaryPrompt, /# Audit base/);
	assert.match(primaryPrompt, /# Output format/);
});

test("checks artifact ignore safety in the selected platform member repo", async () => {
	const platformRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-platform-"));
	const backendRoot = path.join(platformRoot, "backend");
	await mkdir(backendRoot, { recursive: true });
	await execFileAsync("git", ["init"], { cwd: backendRoot });
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
	const { recordAuditStage } = await import("../scripts/record-stage.mjs");
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
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
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

	const { recordAuditStage } = await import("../scripts/record-stage.mjs");
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "primary",
		artifactPath: path.relative(process.cwd(), result.primaryInitialPath),
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
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
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
	const { recordAuditStage } = await import("../scripts/record-stage.mjs");
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
	const projectRoot = await mkdtemp(path.join(tmpdir(), "audit-flow-"));
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
	const { recordAuditStage } = await import("../scripts/record-stage.mjs");
	await recordAuditStage({
		auditYmlPath: result.auditYmlPath,
		stage: "primary",
		artifactPath: result.primaryInitialPath,
		now: new Date("2026-05-07T01:00:00.000Z"),
	});

	const parsed = parseYamlSubset(await readFile(result.auditYmlPath, "utf8"));
	assert.equal(parsed.target.raw, target);
});
