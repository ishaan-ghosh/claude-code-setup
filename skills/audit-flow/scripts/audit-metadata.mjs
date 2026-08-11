import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { parseYamlSubset, toYaml } from "./start-audit.mjs";

const LOCK_TIMEOUT_MS = 10_000;

export async function updateAuditMetadata(auditYmlPath, mutate) {
	const lockPath = `${auditYmlPath}.lock`;
	const lock = await acquireLock(lockPath);
	let tempPath;
	try {
		const text = await lock.readTarget(auditYmlPath);
		const audit = parseYamlSubset(text);
		const result = await mutate(audit);
		tempPath = join(dirname(auditYmlPath), `.audit.yml.${process.pid}.${randomUUID()}.tmp`);
		const temp = await open(tempPath, "wx", 0o600);
		try {
			await temp.writeFile(toYaml(audit), "utf8");
			await temp.sync();
		} finally {
			await temp.close();
		}
		await rename(tempPath, auditYmlPath);
		tempPath = undefined;
		return result;
	} finally {
		if (tempPath) await unlink(tempPath).catch(() => {});
		await lock.close();
		await unlink(lockPath).catch(() => {});
	}
}

async function acquireLock(lockPath) {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`, "utf8");
			return {
				close: () => handle.close(),
				readTarget: async (path) => {
					const target = await open(path, "r");
					try {
						return await target.readFile("utf8");
					} finally {
						await target.close();
					}
				},
			};
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for serialized audit metadata update: ${lockPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}
