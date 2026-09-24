#!/usr/bin/env node
// Release consistency gate: manifests, versions, frontmatter, plugin-root paths, and vendored-file locks.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLUGIN_ROOT_REF = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g;
const MARKDOWN_LINK = /\]\(((?:\.\.?\/)[^)#\s]+)(?:#[^)]*)?\)/g;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(root, relative, errors) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
  } catch (error) {
    errors.push(`${relative}: cannot parse JSON (${error.message})`);
    return null;
  }
}

async function listFiles(directory, predicate) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") await walk(candidate);
      } else if (entry.isFile() && predicate(entry.name)) files.push(candidate);
    }
  }
  await walk(directory);
  return files.sort();
}

export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

async function checkFrontmatter(root, relativeDir, fileName, required, errors) {
  const files = await listFiles(path.join(root, relativeDir), (name) => (fileName ? name === fileName : name.endsWith(".md")));
  for (const file of files) {
    const relative = path.relative(root, file);
    const fields = parseFrontmatter(await fs.readFile(file, "utf8"));
    if (!fields) {
      errors.push(`${relative}: missing closed frontmatter`);
      continue;
    }
    for (const key of required) if (!fields[key]) errors.push(`${relative}: frontmatter has no ${key}`);
    if (fileName === "SKILL.md" && fields.name && fields.name !== path.basename(path.dirname(file))) {
      errors.push(`${relative}: skill name "${fields.name}" differs from its directory`);
    }
  }
  return files.length;
}

export async function checkRelease(root = repoRoot, { tag } = {}) {
  const errors = [];
  const marketplace = await readJson(root, ".claude-plugin/marketplace.json", errors);
  const plugin = await readJson(root, ".claude-plugin/plugin.json", errors);
  const pkg = await readJson(root, "package.json", errors);
  await readJson(root, "hooks/hooks.json", errors);
  if (!marketplace || !plugin || !pkg) return { errors, summary: null };

  const version = plugin.version;
  if (!SEMVER.test(String(version))) errors.push(`.claude-plugin/plugin.json: invalid version ${JSON.stringify(version)}`);
  if (pkg.version !== version) errors.push(`package.json version ${pkg.version} differs from plugin.json ${version}`);
  if (tag !== undefined && tag !== `v${version}`) errors.push(`tag ${tag} does not match release version v${version}`);
  if (plugin.license && !(await exists(path.join(root, "LICENSE")))) errors.push(`plugin.json declares ${plugin.license} but LICENSE is missing`);

  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (!entries.length) errors.push(".claude-plugin/marketplace.json: no plugins listed");
  for (const entry of entries) {
    if (typeof entry.source === "string" && !(await exists(path.join(root, entry.source, ".claude-plugin", "plugin.json")))) {
      errors.push(`marketplace plugin ${entry.name}: source ${entry.source} has no .claude-plugin/plugin.json`);
    }
  }
  if (!entries.some((entry) => entry.name === plugin.name)) errors.push(`marketplace does not list plugin ${plugin.name}`);

  // Pinned install refs in docs and the settings template must track the release.
  const readme = await fs.readFile(path.join(root, "README.md"), "utf8").catch(() => "");
  for (const match of readme.matchAll(new RegExp(`${marketplace.name}@v(\\d+\\.\\d+\\.\\d+)`, "g"))) {
    if (match[1] !== version) errors.push(`README.md pins ${marketplace.name}@v${match[1]}, expected v${version}`);
  }
  for (const match of readme.matchAll(/"ref"\s*:\s*"v(\d+\.\d+\.\d+)"/g)) {
    if (match[1] !== version) errors.push(`README.md settings snippet pins ref v${match[1]}, expected v${version}`);
  }
  const settings = await readJson(root, "settings.example.json", errors);
  const ref = settings?.extraKnownMarketplaces?.[marketplace.name]?.source?.ref;
  if (ref !== undefined && ref !== `v${version}`) errors.push(`settings.example.json ref ${ref} differs from v${version}`);

  const skills = await checkFrontmatter(root, "skills", "SKILL.md", ["name", "description"], errors);
  const agents = await checkFrontmatter(root, "agents", null, ["name", "description"], errors);
  const commands = await checkFrontmatter(root, "commands", null, ["description"], errors);
  if (!skills) errors.push("plugin ships no skills");

  // Every ${CLAUDE_PLUGIN_ROOT}/... reference and relative Markdown link must resolve.
  const documents = [path.join(root, "README.md")];
  for (const dir of ["skills", "agents", "commands", "hooks"]) {
    documents.push(...(await listFiles(path.join(root, dir), (name) => /\.(md|json)$/.test(name))));
  }
  for (const file of documents) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const relative = path.relative(root, file);
    for (const match of text.matchAll(PLUGIN_ROOT_REF)) {
      const target = match[1].replace(/[.]+$/, "");
      if (!(await exists(path.join(root, target)))) errors.push(`${relative}: \${CLAUDE_PLUGIN_ROOT}/${target} does not exist`);
    }
    if (file.endsWith(".md")) {
      // Links inside fenced code blocks are examples, not navigation.
      const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
      for (const match of prose.matchAll(MARKDOWN_LINK)) {
        if (!(await exists(path.resolve(path.dirname(file), match[1])))) errors.push(`${relative}: broken link ${match[1]}`);
      }
    }
  }

  // Plugin agents are registered as <plugin>:<name>; a bare name does not resolve and fails the model policy.
  const agentNames = (await listFiles(path.join(root, "agents"), (name) => name.endsWith(".md"))).map((file) => path.basename(file, ".md"));
  for (const file of documents.filter((candidate) => candidate.endsWith(".md"))) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const match of text.matchAll(/subagent_type[`"'\s:=]*(?:set to\s*)?[`"']?([A-Za-z0-9_:-]+)/g)) {
      if (agentNames.includes(match[1])) errors.push(`${path.relative(root, file)}: subagent_type ${match[1]} must be ${plugin.name}:${match[1]}`);
    }
  }

  await checkVendorLock(root, errors);

  return { errors, summary: { version, skills, agents, commands } };
}

// Vendored upstream skills (vendor/superpowers.lock.json) must match the lock byte for byte.
// Upstream hashes are checked against the pinned archive by `scripts/vendor-superpowers.mjs --verify`.
const VENDOR_LOCK = "vendor/superpowers.lock.json";
const SHA256 = /^[0-9a-f]{64}$/;

async function checkVendorLock(root, errors) {
  if (!(await exists(path.join(root, VENDOR_LOCK)))) return;
  const lock = await readJson(root, VENDOR_LOCK, errors);
  if (!lock) return;
  if (lock.schema !== 1) errors.push(`${VENDOR_LOCK}: unsupported schema ${JSON.stringify(lock.schema)}`);
  for (const key of ["repo", "tag", "commit", "archiveUrl"]) if (typeof lock[key] !== "string" || !lock[key]) errors.push(`${VENDOR_LOCK}: missing ${key}`);
  if (!SHA256.test(String(lock.archiveSha256))) errors.push(`${VENDOR_LOCK}: invalid archiveSha256`);
  const enabled = Array.isArray(lock.enabled) ? lock.enabled : [];
  const excluded = Array.isArray(lock.excluded) ? lock.excluded : [];
  const resources = Array.isArray(lock.resources) ? lock.resources : [];
  if (!enabled.length) errors.push(`${VENDOR_LOCK}: no enabled skills`);
  if (!resources.length) errors.push(`${VENDOR_LOCK}: no resources`);
  if (!lock.license?.file || !resources.some((resource) => resource.target === lock.license.file)) errors.push(`${VENDOR_LOCK}: license file is not a locked resource`);
  for (const item of excluded) {
    if (!item?.skill || !item?.reason) errors.push(`${VENDOR_LOCK}: excluded entry needs skill and reason`);
    else if (enabled.includes(item.skill)) errors.push(`${VENDOR_LOCK}: ${item.skill} is both enabled and excluded`);
    else if (await exists(path.join(root, "skills", item.skill))) errors.push(`${VENDOR_LOCK}: excluded skill ${item.skill} is present under skills/`);
  }

  const covered = new Set();
  const vendoredSkills = new Set();
  for (const resource of resources) {
    const target = String(resource?.target ?? "");
    if (!target || path.isAbsolute(target) || target.split(/[\\/]/).includes("..")) {
      errors.push(`${VENDOR_LOCK}: unsafe resource target ${JSON.stringify(resource?.target)}`);
      continue;
    }
    if (!resource.source || !SHA256.test(String(resource.sha256)) || !SHA256.test(String(resource.upstreamSha256)) || typeof resource.adapted !== "boolean") {
      errors.push(`${VENDOR_LOCK}: ${target} needs source, sha256, upstreamSha256, and adapted`);
      continue;
    }
    covered.add(target);
    const parts = target.split("/");
    if (parts[0] === "skills" && parts.length > 2) vendoredSkills.add(parts[1]);
    if (resource.adapted && resource.sha256 === resource.upstreamSha256) errors.push(`${target}: marked adapted but identical to upstream`);
    if (!resource.adapted && resource.sha256 !== resource.upstreamSha256) errors.push(`${target}: marked unadapted but sha256 differs from upstreamSha256`);
    let bytes;
    try {
      bytes = await fs.readFile(path.join(root, target));
    } catch {
      errors.push(`${target}: vendored file is missing`);
      continue;
    }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== resource.sha256) errors.push(`${target}: does not match its sha256 in ${VENDOR_LOCK}`);
  }

  for (const skill of enabled) {
    if (!vendoredSkills.has(skill)) errors.push(`${VENDOR_LOCK}: enabled skill ${skill} has no vendored files`);
    if (!covered.has(`skills/${skill}/SKILL.md`)) errors.push(`${VENDOR_LOCK}: enabled skill ${skill} has no locked SKILL.md`);
    for (const file of await listFiles(path.join(root, "skills", skill), () => true)) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (!covered.has(relative)) errors.push(`${relative}: not covered by ${VENDOR_LOCK}`);
    }
  }
  for (const skill of vendoredSkills) if (!enabled.includes(skill)) errors.push(`${VENDOR_LOCK}: skills/${skill} is vendored but not enabled`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tagIndex = process.argv.indexOf("--tag");
  if (tagIndex !== -1 && !process.argv[tagIndex + 1]) throw new Error("--tag requires a value");
  const { errors, summary } = await checkRelease(repoRoot, { tag: tagIndex === -1 ? undefined : process.argv[tagIndex + 1] });
  if (errors.length) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`release ${summary.version}: ${summary.skills} skills, ${summary.agents} agents, ${summary.commands} commands verified\n`);
  }
}
