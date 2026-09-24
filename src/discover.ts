/**
 * The account's own model picker from Claude Code's `initialize` handshake. Offline with
 * respect to Anthropic: a relay that would count any Messages request stays unused.
 * Anything unexpected returns undefined so callers keep the pinned catalog.
 */
import type { ChildProcess } from "node:child_process";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { modelConfig, ROUTES, route } from "./catalog.ts";
import { authStatus, BASE_ARGS, childEnv, type Env, killTree, resolveClaude, spawnNative, workDir } from "./native.ts";
import { Relay } from "./relay.ts";

export async function discoverModels(env: Env = process.env, signal?: AbortSignal, timeoutMs = 40_000): Promise<ProviderModelConfig[] | undefined> {
	const claude = resolveClaude(env);
	if (!claude) return undefined;
	// Logged out, the handshake still answers with a generic list; only a signed-in picker is the account's.
	const auth = await authStatus(env);
	if (!auth.loggedIn) return undefined;
	const relay = await Relay.start({ timeoutMs, tools: [] });
	let child: ChildProcess | undefined;
	let timer: NodeJS.Timeout | undefined;
	const stop = () => child && killTree(child);
	try {
		const args = [...BASE_ARGS, "--model", "sonnet", "--mcp-config", '{"mcpServers":{}}'];
		const cwd = await workDir(env);
		const stdout = await new Promise<string>((resolve, reject) => {
			child = spawnNative(claude, args, { cwd, env: childEnv(env, relay.url), stderr: "ignore" });
			let out = "";
			child.stdout!.on("data", (c: Buffer) => {
				out += c.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", () => resolve(out));
			timer = setTimeout(stop, timeoutMs);
			signal?.addEventListener("abort", stop, { once: true });
			if (signal?.aborted) stop();
			child.stdin!.end(`${JSON.stringify({ type: "control_request", request_id: "picker", request: { subtype: "initialize" } })}\n`);
		});
		if (relay.used || signal?.aborted) return undefined;
		const rows = stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
		const response = rows.find((r) => r.type === "control_response")?.response?.response;
		const native: any[] = response?.models ?? [];
		if (!native.length) return undefined;
		const plan = String(response?.account?.subscriptionType ?? auth.plan).toLowerCase();
		const credits = new Set<string>();
		if (plan && !plan.includes("max")) for (const r of ROUTES) if (r.creditsBelowMax) credits.add(r.id);
		for (const row of native) {
			const r = route(String(row.resolvedModel ?? row.value ?? ""));
			if (r && /usage credit/i.test(String(row.description ?? ""))) credits.add(r.id);
		}
		// The native picker omits some pinned routes (Opus 4.8); keep every route, annotated.
		return ROUTES.map((r) => modelConfig(r, credits.has(r.id) ? "usage credits" : ""));
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
		stop();
		await relay.close();
	}
}
