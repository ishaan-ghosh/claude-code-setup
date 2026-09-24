import assert from "node:assert/strict";
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
