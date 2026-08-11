import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

export async function captureTargetSnapshot({ projectRoot, profile = {}, base, head, requireExplicitRefs = false }) {
	const repoInputs = resolveRepoInputs(projectRoot, profile);
	const repos = [];
	const canonicalRoots = new Set();

	for (const repoInput of repoInputs) {
		const gitRootOutput = await gitBytes(repoInput.configuredRoot, ["rev-parse", "--show-toplevel"]);
		const root = await realpath(resolve(decodeUtf8(gitRootOutput).trim()));
		if (canonicalRoots.has(root)) {
			throw new Error(`Audit target contains duplicate Git repository root: ${root}`);
		}
		canonicalRoots.add(root);

		const selectedBase = repoInput.config.base ?? base ?? profile.base;
		const selectedHead = repoInput.config.head ?? head ?? profile.head;
		if (requireExplicitRefs && (selectedBase === undefined || selectedBase === null || selectedHead === undefined || selectedHead === null)) {
			throw new Error(`PR and stack audits require explicit base and head refs for every repository (${root}).`);
		}
		const baseRef = String(selectedBase ?? "HEAD");
		const headRef = String(selectedHead ?? "HEAD");
		const baseOid = decodeUtf8(await gitBytes(root, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim().toLowerCase();
		const headOid = decodeUtf8(await gitBytes(root, ["rev-parse", "--verify", `${headRef}^{commit}`])).trim().toLowerCase();
		if (!/^[0-9a-f]{40,64}$/.test(baseOid) || !/^[0-9a-f]{40,64}$/.test(headOid)) {
			throw new Error(`Audit base/head refs must resolve to commit OIDs in ${root}.`);
		}
		if (requireExplicitRefs && baseOid === headOid) {
			throw new Error(`PR and stack audit base/head refs must resolve to different commits in ${root}.`);
		}
		const stagedDiff = await gitBytes(root, [
			"diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", headOid, "--",
		]);
		const unstagedDiff = await gitBytes(root, [
			"diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", "--",
		]);
		const tracked = await captureTrackedManifest(root);
		const untracked = await captureUntrackedManifest(root);
		const repo = {
			name: String(repoInput.config.name ?? basename(root)),
			role: repoInput.config.role === undefined || repoInput.config.role === null ? null : String(repoInput.config.role),
			root,
			base_ref: baseRef,
			base_oid: baseOid,
			head_ref: headRef,
			head_oid: headOid,
			staged_diff_sha256: sha256(stagedDiff),
			unstaged_diff_sha256: sha256(unstagedDiff),
			tracked_manifest_sha256: sha256(stableJson(tracked)),
			tracked,
			untracked_manifest_sha256: sha256(stableJson(untracked)),
			untracked,
		};
		repo.snapshot_sha256 = sha256(stableJson(repo));
		repos.push(repo);
	}

	return {
		snapshot_schema: "git-worktree-v2",
		snapshot_sha256: sha256(stableJson(repos.map(snapshotIdentity))),
		repos,
	};
}

export async function assertTargetSnapshotUnchanged(target) {
	if (target?.snapshot_schema !== "git-worktree-v2" || !Array.isArray(target.repos) || target.repos.length === 0) {
		throw new Error("Audit metadata is missing a valid git-worktree-v2 target snapshot.");
	}

	const profile = {
		repos: target.repos.map((repo) => ({
			name: repo.name,
			role: repo.role,
			path: repo.root,
			base: repo.base_ref,
			head: repo.head_ref,
		})),
	};
	const current = await captureTargetSnapshot({ projectRoot: target.repos[0].root, profile });
	if (current.snapshot_sha256 !== target.snapshot_sha256 || stableJson(current.repos) !== stableJson(target.repos)) {
		const changed = current.repos
			.filter((repo, index) => stableJson(repo) !== stableJson(target.repos[index]))
			.map((repo) => repo.name);
		throw new Error(`Audit target snapshot changed${changed.length ? ` in: ${changed.join(", ")}` : ""}. Start a new audit for the current target.`);
	}
	return current;
}

async function captureTrackedManifest(root) {
	const output = await gitBytes(root, ["ls-files", "--stage", "-z"]);
	const entries = [];
	for (const rawEntry of splitNul(output)) {
		const tab = rawEntry.indexOf(0x09);
		if (tab < 0) throw new Error("Git returned a malformed tracked-file index entry.");
		const header = decodeUtf8(rawEntry.subarray(0, tab));
		const match = header.match(/^(\d{6}) ([0-9a-fA-F]{40,64}) ([0-3])$/);
		if (!match) throw new Error(`Git returned a malformed tracked-file index header: ${header}`);
		const [, indexMode, rawIndexOid, stage] = match;
		const rawPath = rawEntry.subarray(tab + 1);
		const path = decodeUtf8(rawPath);
		if (stage !== "0") {
			throw new Error(`Audit snapshots do not support unmerged index entries: ${path}`);
		}
		if (indexMode === "160000") {
			throw new Error(`Audit snapshots do not traverse tracked submodules: ${path}. Select the submodule as a separate profile repository.`);
		}
		if (!["100644", "100755", "120000"].includes(indexMode)) {
			throw new Error(`Unsupported tracked Git mode ${indexMode} for audit snapshot path: ${path}`);
		}
		const absolutePath = resolveSafePath(root, path, "tracked");
		await assertNoSymlinkParents(root, absolutePath, path);
		let fileStat;
		try {
			fileStat = await lstat(absolutePath);
		} catch (error) {
			if (error?.code === "ENOENT") {
				entries.push({
					path,
					index_mode: indexMode,
					index_oid: rawIndexOid.toLowerCase(),
					worktree_mode: "missing",
					sha256: null,
				});
				continue;
			}
			throw error;
		}

		let worktreeMode;
		let contents;
		if (fileStat.isSymbolicLink()) {
			worktreeMode = "120000";
			contents = await readlink(absolutePath, { encoding: "buffer" });
		} else if (fileStat.isFile()) {
			worktreeMode = fileStat.mode & 0o111 ? "100755" : "100644";
			contents = await readFile(absolutePath);
		} else {
			throw new Error(`Tracked path has an unsupported filesystem type in the audit worktree: ${path}`);
		}
		entries.push({
			path,
			index_mode: indexMode,
			index_oid: rawIndexOid.toLowerCase(),
			worktree_mode: worktreeMode,
			sha256: sha256(contents),
		});
	}
	return entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function resolveRepoInputs(projectRoot, profile) {
	if (!Array.isArray(profile.repos) || profile.repos.length === 0) {
		return [{ configuredRoot: resolve(projectRoot), config: {} }];
	}
	const contextRootValue = profile.platform?.context_root ?? projectRoot;
	const contextRoot = isAbsolute(contextRootValue)
		? resolve(contextRootValue)
		: resolve(projectRoot, contextRootValue);
	return profile.repos.map((repo, index) => {
		if (!repo?.name || !repo?.path) {
			throw new Error(`Profile repos[${index}] must define both name and path.`);
		}
		return {
			configuredRoot: isAbsolute(repo.path) ? resolve(repo.path) : resolve(contextRoot, repo.path),
			config: repo,
		};
	});
}

async function captureUntrackedManifest(root) {
	const output = await gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	const rawPaths = splitNul(output).sort(Buffer.compare);
	const manifest = [];
	for (const rawPath of rawPaths) {
		const path = decodeUtf8(rawPath);
		const absolutePath = resolveSafePath(root, path, "untracked");
		await assertNoSymlinkParents(root, absolutePath, path);
		const fileStat = await lstat(absolutePath);
		let mode;
		let contents;
		if (fileStat.isSymbolicLink()) {
			mode = "120000";
			contents = await readlink(absolutePath, { encoding: "buffer" });
		} else if (fileStat.isFile()) {
			mode = fileStat.mode & 0o111 ? "100755" : "100644";
			contents = await readFile(absolutePath);
		} else {
			throw new Error(`Unsupported untracked filesystem entry for audit snapshot: ${path}`);
		}
		manifest.push({ path, mode, sha256: sha256(contents) });
	}
	return manifest;
}

function resolveSafePath(root, path, kind) {
	if (!path) throw new Error(`Git returned an empty ${kind} path.`);
	const absolutePath = resolve(root, path);
	const relativePath = relative(root, absolutePath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`Git returned an unsafe ${kind} path: ${path}`);
	}
	return absolutePath;
}

async function assertNoSymlinkParents(root, absolutePath, displayPath) {
	let current = dirname(absolutePath);
	const parents = [];
	while (current !== root) {
		const relativePath = relative(root, current);
		if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error(`Tracked path escapes its repository through a parent component: ${displayPath}`);
		}
		parents.push(current);
		current = dirname(current);
	}
	for (const parent of parents.reverse()) {
		try {
			if ((await lstat(parent)).isSymbolicLink()) {
				throw new Error(`Audit snapshot path contains a symbolic-link parent component: ${displayPath}`);
			}
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
	}
}

async function gitBytes(cwd, args) {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			encoding: "buffer",
			maxBuffer: MAX_GIT_OUTPUT,
		});
		return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
	} catch (error) {
		const detail = error?.stderr ? decodeUtf8(Buffer.from(error.stderr)).trim() : error?.message;
		throw new Error(`Unable to capture audit target Git state in ${cwd}: ${detail || "git command failed"}`);
	}
}

function splitNul(buffer) {
	const entries = [];
	let start = 0;
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index] !== 0) continue;
		if (index > start) entries.push(buffer.subarray(start, index));
		start = index + 1;
	}
	if (start !== buffer.length) {
		throw new Error("Git returned a malformed NUL-delimited untracked-file list.");
	}
	return entries;
}

function decodeUtf8(buffer) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new Error("Audit snapshots require Git paths and output to be valid UTF-8.");
	}
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
	return JSON.stringify(sortValue(value));
}

function sortValue(value) {
	if (Array.isArray(value)) return value.map(sortValue);
	if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function snapshotIdentity(repo) {
	const { snapshot_sha256: _snapshotSha256, ...identity } = repo;
	return identity;
}
