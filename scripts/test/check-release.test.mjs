import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRelease, parseFrontmatter } from "../check-release.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function write(root, relative, contents) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-release-check-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    ".claude-plugin/marketplace.json": { name: "demo", plugins: [{ name: "demo-plugin", source: "./" }] },
    ".claude-plugin/plugin.json": { name: "demo-plugin", version: "1.2.3", license: "MIT" },
    "package.json": { name: "demo", version: "1.2.3" },
    "LICENSE": "MIT\n",
    "README.md": "Install `demo@v1.2.3`.\n",
    "settings.example.json": { extraKnownMarketplaces: { demo: { source: { ref: "v1.2.3" } } } },
    "hooks/hooks.json": { hooks: {} },
    "hooks/run.mjs": "",
    "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Does alpha.\n---\nRun `${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs`.\n",
    "agents/helper.md": "---\nname: helper\ndescription: Helps.\n---\nBody\n",
    "commands/go.md": "---\ndescription: Go\n---\nBody\n",
    ...overrides,
  };
  for (const [relative, contents] of Object.entries(files)) if (contents !== null) await write(root, relative, contents);
  return root;
}

test("the repository itself passes the release check", async () => {
  const { errors } = await checkRelease(repoRoot);
  assert.deepEqual(errors, []);
});

test("a consistent fixture passes and reports counts", async (t) => {
  const { errors, summary } = await checkRelease(await fixture(t));
  assert.deepEqual(errors, []);
  assert.deepEqual(summary, { version: "1.2.3", skills: 1, agents: 1, commands: 1 });
});

test("version drift across manifests, docs, settings, and tags is reported", async (t) => {
  const root = await fixture(t, {
    "package.json": { name: "demo", version: "1.2.4" },
    "README.md": "Install `demo@v1.2.2`.\n",
    "settings.example.json": { extraKnownMarketplaces: { demo: { source: { ref: "v1.0.0" } } } },
  });
  const { errors } = await checkRelease(root, { tag: "v9.9.9" });
  assert.equal(errors.length, 4);
  assert.match(errors.join("\n"), /package\.json version 1\.2\.4/);
  assert.match(errors.join("\n"), /tag v9\.9\.9/);
  assert.match(errors.join("\n"), /README\.md pins demo@v1\.2\.2/);
  assert.match(errors.join("\n"), /settings\.example\.json ref v1\.0\.0/);
});

test("frontmatter problems are reported", async (t) => {
  const root = await fixture(t, {
    "skills/alpha/SKILL.md": "---\nname: beta\ndescription: Mismatched.\n---\n",
    "skills/gamma/SKILL.md": "no frontmatter\n",
    "agents/helper.md": "---\nname: helper\n---\n",
    "commands/go.md": "---\nargument-hint: x\n---\n",
  });
  const { errors } = await checkRelease(root);
  assert.deepEqual(errors.sort(), [
    "agents/helper.md: frontmatter has no description",
    "commands/go.md: frontmatter has no description",
    'skills/alpha/SKILL.md: skill name "beta" differs from its directory',
    "skills/gamma/SKILL.md: missing closed frontmatter",
  ]);
});

test("missing plugin-root paths, broken links, and missing LICENSE are reported; fenced examples are not", async (t) => {
  const root = await fixture(t, {
    LICENSE: null,
    "skills/alpha/SKILL.md": [
      "---\nname: alpha\ndescription: Does alpha.\n---",
      "Run `${CLAUDE_PLUGIN_ROOT}/hooks/missing.mjs`.",
      "See [ref](./REFERENCE.md).",
      "```md\n[example](./src/example.md)\n```\n",
    ].join("\n"),
  });
  const { errors } = await checkRelease(root);
  assert.deepEqual(errors.sort(), [
    "plugin.json declares MIT but LICENSE is missing",
    "skills/alpha/SKILL.md: ${CLAUDE_PLUGIN_ROOT}/hooks/missing.mjs does not exist",
    "skills/alpha/SKILL.md: broken link ./REFERENCE.md",
  ]);
});

test("parseFrontmatter reads quoted values and rejects unclosed fences", () => {
  assert.deepEqual(parseFrontmatter('---\nname: "a"\ndescription: \'b c\'\n---\nbody'), { name: "a", description: "b c" });
  assert.equal(parseFrontmatter("---\nname: a\n"), null);
});

test("bare plugin agent names in subagent_type references are reported", async (t) => {
  const root = await fixture(t, {
    "commands/go.md": "---\ndescription: Go\n---\nLaunch the Agent tool (`subagent_type: helper`), then `subagent_type: demo-plugin:helper`.\n",
  });
  const { errors } = await checkRelease(root);
  assert.deepEqual(errors, ["commands/go.md: subagent_type helper must be demo-plugin:helper"]);
});

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function vendored({ upstream = "---\nname: vend\ndescription: Vendored.\n---\nUpstream body.\n", committed = upstream, extra = {} } = {}) {
  const license = "MIT upstream\n";
  const lock = {
    schema: 1,
    repo: "https://example.invalid/up",
    tag: "v1.0.0",
    commit: "abc",
    archiveUrl: "https://example.invalid/up.tar.gz",
    archiveSha256: sha("archive"),
    license: { spdx: "MIT", file: "vendor/up-LICENSE" },
    enabled: ["vend"],
    excluded: [{ skill: "dropped", reason: "Not wanted." }],
    resources: [
      { source: "up/LICENSE", target: "vendor/up-LICENSE", upstreamSha256: sha(license), sha256: sha(license), adapted: false },
      { source: "up/skills/vend/SKILL.md", target: "skills/vend/SKILL.md", upstreamSha256: sha(upstream), sha256: sha(committed), adapted: committed !== upstream },
    ],
  };
  return { "vendor/superpowers.lock.json": lock, "vendor/up-LICENSE": license, "skills/vend/SKILL.md": committed, ...extra };
}

test("a vendored skill that matches its lock passes, adapted or not", async (t) => {
  assert.deepEqual((await checkRelease(await fixture(t, vendored()))).errors, []);
  const adapted = vendored({ committed: "---\nname: vend\ndescription: Vendored.\n---\nAdapted body.\n" });
  assert.deepEqual((await checkRelease(await fixture(t, adapted))).errors, []);
});

test("a tampered vendored file is reported", async (t) => {
  const files = vendored();
  files["skills/vend/SKILL.md"] = "---\nname: vend\ndescription: Vendored.\n---\nTampered.\n";
  const { errors } = await checkRelease(await fixture(t, files));
  assert.deepEqual(errors, ["skills/vend/SKILL.md: does not match its sha256 in vendor/superpowers.lock.json"]);
});

test("a file in a vendored skill that the lock does not cover is reported", async (t) => {
  const { errors } = await checkRelease(await fixture(t, vendored({ extra: { "skills/vend/notes.md": "extra\n" } })));
  assert.deepEqual(errors, ["skills/vend/notes.md: not covered by vendor/superpowers.lock.json"]);
});

test("vendor lock inconsistencies are reported", async (t) => {
  const files = vendored({ extra: { "skills/dropped/SKILL.md": "---\nname: dropped\ndescription: Dropped.\n---\n" } });
  const lock = files["vendor/superpowers.lock.json"];
  lock.enabled = ["vend", "missing"];
  lock.resources[1].adapted = true;
  const { errors } = await checkRelease(await fixture(t, files));
  assert.deepEqual(errors.sort(), [
    "skills/vend/SKILL.md: marked adapted but identical to upstream",
    "vendor/superpowers.lock.json: enabled skill missing has no locked SKILL.md",
    "vendor/superpowers.lock.json: enabled skill missing has no vendored files",
    "vendor/superpowers.lock.json: excluded skill dropped is present under skills/",
  ]);
});

test("an unparseable vendor lock is reported", async (t) => {
  const { errors } = await checkRelease(await fixture(t, { "vendor/superpowers.lock.json": "{ nope" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^vendor\/superpowers\.lock\.json: cannot parse JSON/);
});
