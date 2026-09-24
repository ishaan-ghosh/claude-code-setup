#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_PATH = /(?:^|\/)(?:auth\.json|\.env(?:\..*)?$|storage-state\.json|[^/]+\.pem|id_rsa)$/i;

// Build credential markers from fragments so this checker cannot match its own
// source as a secret. The scan operates only on Git-index paths and blobs.
const PRIVATE_KEY_MARKERS = [
  ["BEGIN", "PRIVATE", "KEY"].join(" "),
  ["BEGIN", "RSA", "PRIVATE", "KEY"].join(" "),
  ["BEGIN", "EC", "PRIVATE", "KEY"].join(" "),
  ["BEGIN", "OPENSSH", "PRIVATE", "KEY"].join(" "),
];
const SQL_SCHEMES = ["postgres", "postgresql"].join("|");
const SQL_CREDENTIAL = new RegExp(`(?:${SQL_SCHEMES})` + "://" + "[^\\s]+:[^\\s@]+@", "i");
const REDIS_CREDENTIAL = new RegExp("redis" + "://" + ":[^\\s@]+@", "i");
const ANTHROPIC_KEY = new RegExp("sk-" + "ant-" + "[A-Za-z0-9_-]{20,}");
const GITHUB_TOKEN = new RegExp("\\b(?:gh[pousr]_" + "[A-Za-z0-9]{36,}|github_pat_" + "[A-Za-z0-9_]{40,})");

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function scanEntries(entries) {
  const findings = [];
  for (const entry of entries) {
    const relative = String(entry.path);
    if (FORBIDDEN_PATH.test(relative)) findings.push({ path: relative, line: 1, kind: "credential-like filename" });
    if (/(?:^|\/)test\/fixtures\//.test(relative)) continue;
    const text = String(entry.contents);
    for (const marker of PRIVATE_KEY_MARKERS) {
      const index = text.indexOf(marker);
      if (index >= 0) findings.push({ path: relative, line: lineNumber(text, index), kind: "private-key marker" });
    }
    for (const pattern of [SQL_CREDENTIAL, REDIS_CREDENTIAL]) {
      const match = pattern.exec(text);
      if (match) findings.push({ path: relative, line: lineNumber(text, match.index), kind: "database credential URL" });
    }
    for (const [pattern, kind] of [[ANTHROPIC_KEY, "Anthropic API key"], [GITHUB_TOKEN, "GitHub token"]]) {
      const match = pattern.exec(text);
      if (match) findings.push({ path: relative, line: lineNumber(text, match.index), kind });
    }
  }
  return findings;
}

function parseIndexEntries(stdout) {
  const entries = [];
  const seen = new Set();
  for (const record of stdout.toString("utf8").split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("git index listing is malformed");
    const [mode, object, stage] = record.slice(0, separator).split(/\s+/);
    const relative = record.slice(separator + 1);
    if (seen.has(relative)) throw new Error(`git index contains duplicate or conflicted path: ${relative}`);
    seen.add(relative);
    if (stage !== "0") throw new Error(`git index contains an unmerged path: ${relative}`);
    if (mode !== "100644" && mode !== "100755") throw new Error(`unsupported non-regular tracked mode ${mode}: ${relative}`);
    if (!/^[0-9a-f]{40,64}$/.test(object)) throw new Error(`git index contains an invalid object id: ${relative}`);
    entries.push({ relative, object });
  }
  return entries;
}

async function trackedEntries(root) {
  const { stdout: listing } = await execFileAsync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  const indexEntries = parseIndexEntries(listing);
  return Promise.all(indexEntries.map(async ({ relative, object }) => {
    const { stdout } = await execFileAsync("git", ["cat-file", "blob", object], { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    return { path: relative, contents: stdout.toString("utf8") };
  }));
}

export async function checkTrackedSecrets(root = repoRoot) {
  return scanEntries(await trackedEntries(root));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await checkTrackedSecrets();
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.path}:${finding.line}: ${finding.kind}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("tracked secret hygiene: clean\n");
  }
}
