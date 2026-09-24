#!/usr/bin/env node
// Vendored obra/superpowers skills: pin, provenance, and upstream verification.
//
// The pin and the file inventory live in vendor/superpowers.lock.json. The
// vendored files are committed under skills/<upstream-name>/ (plus the upstream
// LICENSE at vendor/superpowers-LICENSE); adapted files differ from upstream and
// are marked `adapted: true` in the lock. `npm run check` verifies the committed
// files against the lock offline (scripts/check-release.mjs); this script is the
// networked half.
//
// Usage (Node >= 22, `tar` on PATH, network access to github.com):
//   node scripts/vendor-superpowers.mjs --verify
//       Download the pinned archive, check archiveSha256, check every resource's
//       upstreamSha256 against the archive, and check that the enabled upstream
//       skills contain no files the lock neither vendors nor excludes.
//   node scripts/vendor-superpowers.mjs --extract <dir>
//       Extract the pinned upstream files for every resource into <dir>
//       (<dir>/<target>), for diffing against the committed adaptations.
//   node scripts/vendor-superpowers.mjs --write-lock
//       Rebuild `resources` from the pinned archive (enabled skills minus
//       `excludedResources`, plus LICENSE) and the committed target bytes.
//
// Bumping the pin: set tag, commit, archiveUrl, and archiveSha256 in the lock;
// run --extract to a scratch dir; copy unadapted files over and re-apply each
// adaptation listed in the lock by hand; then run --write-lock and --verify.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = "vendor/superpowers.lock.json";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) files.push(path.join(entry.parentPath, entry.name));
    else if (!entry.isDirectory()) throw new Error(`unexpected non-regular entry: ${path.join(entry.parentPath, entry.name)}`);
  }
  return files.sort();
}

async function fetchArchive(lock, directory) {
  const response = await fetch(lock.archiveUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`archive download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds size limit");
  const actual = sha256(bytes);
  if (actual !== lock.archiveSha256) throw new Error(`archiveSha256 mismatch: lock ${lock.archiveSha256}, downloaded ${actual}`);
  const archive = path.join(directory, "superpowers.tar.gz");
  await fs.writeFile(archive, bytes);
  const out = path.join(directory, "x");
  await fs.mkdir(out);
  execFileSync("tar", ["-xzf", archive, "-C", out, "--no-same-owner", "--no-same-permissions"], { stdio: "inherit" });
  const roots = await fs.readdir(out);
  if (roots.length !== 1 || roots[0] !== `superpowers-${lock.commit}`) throw new Error(`unexpected archive root: ${roots.join(", ")}`);
  return out;
}

/** Upstream files the lock should cover: enabled skills minus excluded resources, plus LICENSE. */
async function upstreamInventory(lock, extracted) {
  const root = `superpowers-${lock.commit}`;
  const excluded = (lock.excludedResources ?? []).map((item) => item.source);
  const isExcluded = (source) => excluded.some((prefix) => source === prefix || (prefix.endsWith("/") && source.startsWith(prefix)));
  const inventory = [{ source: `${root}/LICENSE`, target: lock.license.file }];
  for (const skill of lock.enabled) {
    const dir = path.join(extracted, root, "skills", skill);
    for (const file of await listFiles(dir)) {
      const relative = path.relative(dir, file).split(path.sep).join("/");
      if (isExcluded(`skills/${skill}/${relative}`)) continue;
      inventory.push({ source: `${root}/skills/${skill}/${relative}`, target: `skills/${skill}/${relative}` });
    }
  }
  return inventory.sort((a, b) => a.target.localeCompare(b.target));
}

async function verify(lock, extracted) {
  const errors = [];
  const inventory = await upstreamInventory(lock, extracted);
  const locked = new Map(lock.resources.map((resource) => [resource.source, resource]));
  for (const { source } of inventory) if (!locked.has(source)) errors.push(`upstream file not in lock (vendor or exclude it): ${source}`);
  for (const resource of lock.resources) {
    let bytes;
    try {
      bytes = await fs.readFile(path.join(extracted, resource.source));
    } catch {
      errors.push(`${resource.source}: missing from archive`);
      continue;
    }
    if (sha256(bytes) !== resource.upstreamSha256) errors.push(`${resource.source}: upstreamSha256 mismatch`);
  }
  return errors;
}

async function writeLock(lock, extracted) {
  const resources = [];
  for (const { source, target } of await upstreamInventory(lock, extracted)) {
    const upstreamSha256 = sha256(await fs.readFile(path.join(extracted, source)));
    const current = sha256(await fs.readFile(path.join(repoRoot, target)));
    resources.push({ source, target, upstreamSha256, sha256: current, adapted: current !== upstreamSha256 });
  }
  const next = { ...lock, resources };
  await fs.writeFile(path.join(repoRoot, LOCK_PATH), `${JSON.stringify(next, null, 2)}\n`);
  return resources;
}

async function extractTo(lock, extracted, destination) {
  for (const resource of lock.resources) {
    const file = path.join(destination, resource.target);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(path.join(extracted, resource.source), file);
  }
}

async function main(argv) {
  const mode = argv[0];
  if (!["--verify", "--write-lock", "--extract"].includes(mode) || (mode === "--extract" && !argv[1])) {
    process.stderr.write("usage: vendor-superpowers.mjs --verify | --write-lock | --extract <dir>\n");
    process.exitCode = 2;
    return;
  }
  const lock = JSON.parse(await fs.readFile(path.join(repoRoot, LOCK_PATH), "utf8"));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-superpowers-"));
  try {
    const extracted = await fetchArchive(lock, scratch);
    if (mode === "--verify") {
      const errors = await verify(lock, extracted);
      for (const error of errors) process.stderr.write(`${error}\n`);
      if (errors.length) process.exitCode = 1;
      else process.stdout.write(`superpowers ${lock.tag} (${lock.commit.slice(0, 12)}): archive and ${lock.resources.length} upstream resources verified\n`);
    } else if (mode === "--write-lock") {
      const resources = await writeLock(lock, extracted);
      process.stdout.write(`${LOCK_PATH}: ${resources.length} resources, ${resources.filter((r) => r.adapted).length} adapted\n`);
    } else {
      await extractTo(lock, extracted, path.resolve(argv[1]));
      process.stdout.write(`extracted ${lock.resources.length} upstream files to ${path.resolve(argv[1])}\n`);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
