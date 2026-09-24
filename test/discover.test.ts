import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverModels } from "../src/discover.ts";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a hanging native is killed with its descendants on timeout", { skip: process.platform === "win32" }, async () => {
	const bin = join(tmpdir(), `hang-claude-${process.pid}.mjs`);
	const pidFile = join(tmpdir(), `hang-claude-${process.pid}.pid`);
	const cache = join(tmpdir(), `claude-sub-cache-discover-${process.pid}`);
	writeFileSync(
		bin,
		`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, subscriptionType: "max" })); process.exit(0); }
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setInterval(() => {}, 1000);
`,
		{ mode: 0o755 },
	);
	try {
		const started = Date.now();
		assert.equal(await discoverModels({ ...process.env, XDG_CACHE_HOME: cache, CLAUDE_SUBSCRIPTION_COMMAND: bin }, undefined, 1500), undefined);
		assert.ok(Date.now() - started < 5000);
		const pid = Number(readFileSync(pidFile, "utf8"));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(alive(pid), false);
	} finally {
		rmSync(bin, { force: true });
		rmSync(pidFile, { force: true });
		rmSync(cache, { recursive: true, force: true });
	}
});
