import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { checkTrackedSecrets, scanEntries } from "../check-secrets.mjs";

test("clean tracked entries have no findings", () => {
  assert.deepEqual(scanEntries([{ path: "README.md", contents: "documentation only\n" }]), []);
});

test("forbidden credential filenames are reported", () => {
  const findings = scanEntries([
    { path: "config/auth.json", contents: "{}" },
    { path: "secrets/service.pem", contents: "placeholder" },
    { path: ".env.local", contents: "placeholder" },
    { path: "browser/storage-state.json", contents: "placeholder" },
    { path: "ssh/id_rsa", contents: "placeholder" },
  ]);
  assert.equal(findings.length, 5);
  assert.ok(findings.every((finding) => finding.kind === "credential-like filename"));
});

test("private-key and database credential content is reported without printing values", () => {
  const privateMarker = ["BEGIN", "OPENSSH", "PRIVATE", "KEY"].join(" ");
  const postgresCredential = ["postgres", "ql://user:password@db.example/one"].join("");
  const redisCredential = ["redis", "://:password@cache.example"].join("");
  const findings = scanEntries([{ path: "docs/example.txt", contents: `${privateMarker}\n${postgresCredential}\n${redisCredential}\n` }]);
  assert.equal(findings.length, 3);
  assert.deepEqual(findings.map((finding) => finding.kind), ["private-key marker", "database credential URL", "database credential URL"]);
  assert.ok(findings.every((finding) => !Object.hasOwn(finding, "contents")));
});

test("Anthropic API keys and GitHub tokens are reported", () => {
  const anthropicKey = ["sk", "ant", "api03", "x".repeat(32)].join("-");
  const githubToken = "ghp_" + "A".repeat(36);
  const findings = scanEntries([{ path: "settings.json", contents: `key=${anthropicKey}\ntoken=${githubToken}\n` }]);
  assert.deepEqual(findings.map((finding) => [finding.kind, finding.line]), [["Anthropic API key", 1], ["GitHub token", 2]]);
});

test("fixture content is ignored but fixture credential filenames remain protected", () => {
  const marker = ["BEGIN", "PRIVATE", "KEY"].join(" ");
  const findings = scanEntries([{ path: "skills/audit-flow/test/fixtures/auth.json", contents: marker }]);
  assert.deepEqual(findings.map((finding) => finding.kind), ["credential-like filename"]);
});

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function repo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-secret-scan-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  return root;
}

test("scanner reads staged blob bytes instead of working-tree bytes", async (t) => {
  const root = await repo(t);
  const tracked = path.join(root, "staged.txt");
  const outside = path.join(root, "..", "claude-secret-scan-outside-" + process.pid);
  await fs.writeFile(tracked, ["BEGIN", "PRIVATE", "KEY"].join(" ") + "\n");
  await git(root, "add", "staged.txt");
  await fs.writeFile(outside, "clean working tree\n");
  await fs.rm(tracked);
  await fs.symlink(outside, tracked);
  const findings = await checkTrackedSecrets(root);
  assert.deepEqual(findings.map((finding) => finding.kind), ["private-key marker"]);
  await fs.rm(outside, { force: true });
});

test("tracked symlinks are rejected without reading their outside target", async (t) => {
  const root = await repo(t);
  const outside = path.join(root, "..", "claude-secret-scan-link-" + process.pid);
  await fs.writeFile(outside, ["BEGIN", "PRIVATE", "KEY"].join(" ") + "\n");
  await fs.symlink(outside, path.join(root, "tracked-link.txt"));
  await git(root, "add", "tracked-link.txt");
  await assert.rejects(() => checkTrackedSecrets(root), /unsupported non-regular tracked mode 120000/);
  await fs.rm(outside, { force: true });
});
