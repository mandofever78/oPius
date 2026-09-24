import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { type AssistantMessage, type Message, normalizeContext, Type } from "@earendil-works/pi-ai";
import { API, BASE_URL, PROVIDER, STATIC_MODELS } from "../src/catalog.ts";
import { streamClaudeCode } from "../src/stream.ts";
import { fakeUpstream, type Script, textAnswer, toolAnswer } from "./fixtures/upstream.ts";

const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const model = { ...STATIC_MODELS.find((m) => m.id === "claude-sonnet-5")!, api: API, provider: PROVIDER, baseUrl: BASE_URL } as any;
const tools = [{ name: "pi_echo", description: "Echo through pi", parameters: Type.Object({ pi_text: Type.String() }) }];
const log = join(tmpdir(), `fake-claude-${process.pid}.log`);
// Native's stable working directory lives here instead of the real ~/.cache.
const cache = join(tmpdir(), `claude-sub-cache-${process.pid}`);
process.env.XDG_CACHE_HOME = cache;
const temps: string[] = [];
afterEach(() => {
	for (const path of [log, cache, ...temps.splice(0)]) rmSync(path, { recursive: true, force: true });
});

/** A throwaway stand-in for `claude`, removed after the test. */
function fakeBin(name: string, body: string): string {
	const path = join(tmpdir(), `${name}-claude-${process.pid}.mjs`);
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
	temps.push(path);
	return path;
}

function logRows(): any[] {
	return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

async function run(script: Script, messages: Message[], options: Record<string, unknown> = {}) {
	const upstream = await fakeUpstream(script);
	try {
		const env = { CLAUDE_SUBSCRIPTION_COMMAND: FAKE, CLAUDE_SUBSCRIPTION_UPSTREAM: upstream.url, FAKE_CLAUDE_LOG: log, ANTHROPIC_API_KEY: "sk-should-be-stripped", ...(options.env as object) };
		const s = streamClaudeCode(model, normalizeContext({ systemPrompt: "You are pi.", tools, messages }), { ...options, env });
		const events: any[] = [];
		for await (const e of s) events.push(e);
		return { message: (await s.result()) as AssistantMessage, events, upstream };
	} finally {
		await upstream.close();
	}
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

test("text answer: one upstream request, native recovery denied, body forwarded as native built it", async () => {
	const { message, events, upstream } = await run({ events: textAnswer("hello there") }, [user("hi pi")]);
	assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
	assert.deepEqual(message.content, [{ type: "text", text: "hello there" }]);
	assert.equal(events[0].type, "start");
	assert.equal(events.at(-1).type, "done");
	assert.equal(message.usage.input, 10);
	assert.ok(message.usage.cost.total > 0);
	assert.equal(upstream.bodies.length, 1, "exactly one upstream request");
	assert.match(upstream.paths[0], /^\/v1\/messages\?beta=true$/);
	const body = upstream.bodies[0];
	const parsed = JSON.parse(body);
	assert.equal(parsed.system[0].text, "Claude Code preamble mentions pi too", "native's body is not rewritten");
	assert.equal(parsed.system[1].text, "You are pi.");
	assert.equal(parsed.messages[0].content[0].text, "hi pi");
	assert.equal(parsed.tools[0].name, "mcp__pi__pi_echo");
	assert.deepEqual(parsed.tools[0].input_schema.required, ["pi_text"]);
	assert.deepEqual(parsed.thinking, { type: "disabled" });
	const rows = logRows();
	assert.equal(rows[0].env.key, null, "pi's ANTHROPIC_API_KEY never reaches native");
	assert.match(rows.at(-1).body, /PI_MODEL_ADMISSION_CONSUMED/);
});

test("tool round: streamed tool call mapped to the pi tool, signed thinking kept", async () => {
	const { message, events } = await run({ events: toolAnswer("mcp__pi__pi_echo", { pi_text: "hi" }) }, [user("echo")], { reasoning: "high" });
	assert.equal(message.stopReason, "toolUse", message.errorMessage ?? "");
	assert.deepEqual(message.content[0], { type: "thinking", thinking: "Let me call it.", thinkingSignature: "sig+pi/abc" });
	assert.deepEqual(message.content[1], { type: "toolCall", id: "toolu_1", name: "pi_echo", arguments: { pi_text: "hi" } });
	assert.deepEqual(events.map((e) => e.type).filter((t, i, a) => t !== a[i - 1]), ["start", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
});

test("replay: history frames acknowledged, same-model signature replayed, tool result queries", async () => {
	const first = await run({ events: toolAnswer("mcp__pi__pi_echo", { pi_text: "hi" }) }, [user("echo")], { reasoning: "high" });
	const history: Message[] = [
		user("echo"),
		first.message,
		{ role: "toolResult", toolCallId: "toolu_1", toolName: "pi_echo", content: [{ type: "text", text: "done by pi" }], isError: false, timestamp: 2 },
	];
	const { message, upstream } = await run({ events: textAnswer("ok") }, history, { reasoning: "high" });
	assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
	const sent = JSON.parse(upstream.bodies[0]);
	assert.equal(sent.messages.length, 3);
	assert.deepEqual(sent.messages[1].content[0], { type: "thinking", thinking: "Let me call it.", signature: "sig+pi/abc" });
	assert.equal(sent.messages[1].content[1].name, "mcp__pi__pi_echo");
	assert.deepEqual(sent.messages[1].content[1].input, { pi_text: "hi" });
	assert.equal(sent.messages[2].content[0].content[0].text, "done by pi");
	assert.deepEqual(sent.messages[1].content[1].cache_control, { type: "ephemeral", ttl: "1h" }, "history breakpoint on the last assistant block");
	assert.deepEqual(sent.thinking, { type: "adaptive", display: "summarized" });
	assert.deepEqual(sent.output_config, { effort: "high" });
});

test("unknown tool from native fails instead of reaching pi", async () => {
	const { message } = await run({ events: toolAnswer("mcp__pi__rm_rf", {}) }, [user("a")]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage!, /outside the current inventory/);
});

test("foreign assistant turns: thinking becomes text, long tool ids are normalized", async () => {
	const foreign: AssistantMessage = {
		role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-6", stopReason: "toolUse", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "thinking", thinking: "plan", thinkingSignature: "enc" }, { type: "toolCall", id: "call|very/long", name: "pi_echo", arguments: { pi_text: "x" } }],
	};
	const history: Message[] = [user("a"), foreign, { role: "toolResult", toolCallId: "call|very/long", toolName: "pi_echo", content: [{ type: "text", text: "r" }], isError: false, timestamp: 2 }];
	const { upstream } = await run({ events: textAnswer("ok") }, history);
	const sent = JSON.parse(upstream.bodies[0]);
	assert.deepEqual(sent.messages[1].content[0], { type: "text", text: "plan" });
	const id = sent.messages[1].content[1].id;
	assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
	assert.equal(sent.messages[2].content[0].tool_use_id, id);
});

test("upstream error keeps the service's own message for pi's overflow detection", async () => {
	const { message, events } = await run({ status: 400, error: "prompt is too long: 1200000 tokens > 1000000 maximum" }, [user("a")]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage!, /^prompt is too long/);
	assert.equal(events.length, 1, "error before start terminates directly");
});

test("abort kills native and reports aborted", async () => {
	const controller = new AbortController();
	const upstream = await fakeUpstream({ events: textAnswer("x") });
	try {
		const hang = fakeBin("hang", "setInterval(() => {}, 1000);");
		const s = streamClaudeCode(model, normalizeContext({ messages: [user("a")] }), { signal: controller.signal, env: { CLAUDE_SUBSCRIPTION_COMMAND: hang, CLAUDE_SUBSCRIPTION_UPSTREAM: upstream.url } });
		setTimeout(() => controller.abort(), 300);
		const message = await s.result();
		assert.equal(message.stopReason, "aborted");
	} finally {
		await upstream.close();
	}
});

test("haiku gets a thinking budget instead of adaptive effort", async () => {
	const haiku = { ...model, ...STATIC_MODELS.find((m) => m.id.startsWith("claude-haiku")) };
	let payload: any;
	const s = streamClaudeCode(haiku, normalizeContext({ messages: [user("a")] }), { reasoning: "medium", onPayload: (body: any) => { payload = body; }, env: { CLAUDE_SUBSCRIPTION_COMMAND: "/nonexistent/claude" } });
	await s.result();
	assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 8192, display: "summarized" });
	assert.equal(payload.output_config, undefined);
	assert.equal(payload.max_tokens, 64_000);
});

test("tools asking for constrained sampling get strict schemas; unsupported ones fall back", async () => {
	const constrained = [
		{ name: "bash", description: "Run", parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }), constrainedSampling: { type: "json_schema", strict: "prefer" } },
		{ name: "loose", description: "Any", parameters: Type.Object({ data: Type.Record(Type.String(), Type.String()) }), constrainedSampling: { type: "json_schema", strict: "prefer" } },
	] as any[];
	let payload: any;
	const s = streamClaudeCode(model, normalizeContext({ tools: [...tools, ...constrained], messages: [user("a")] }), { onPayload: (body: any) => { payload = body; }, env: { CLAUDE_SUBSCRIPTION_COMMAND: "/nonexistent/claude" } });
	await s.result();
	const [echo, bash, loose] = payload.tools;
	assert.equal(echo.strict, undefined);
	assert.equal(bash.strict, true);
	assert.deepEqual(bash.input_schema.required, ["command", "timeout"]);
	assert.equal(bash.input_schema.additionalProperties, false);
	assert.deepEqual(bash.input_schema.properties.timeout.anyOf[1], { type: "null" });
	assert.equal(loose.strict, undefined, "schema-valued additionalProperties cannot be strict");
});

test("native exiting before reading a large history fails the request, not the host", async () => {
	const quit = fakeBin("quit", "process.exit(3);");
	const s = streamClaudeCode(model, normalizeContext({ messages: [user("x".repeat(4 << 20)), user("b")] }), { env: { CLAUDE_SUBSCRIPTION_COMMAND: quit } });
	const message = await s.result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage!, /exit/);
});

test("native runs in one stable private working directory, secrets stay in the per-call temp dir", async () => {
	await run({ events: textAnswer("a") }, [user("a")]);
	await run({ events: textAnswer("b") }, [user("b")]);
	const spawns = logRows().filter((r) => r.argv);
	const dir = join(cache, "pi-claude-subscription", "cwd");
	assert.deepEqual(spawns.map((r) => r.cwd), [dir, dir]);
	const secrets = spawns.map((r) => dirname(r.argv[r.argv.indexOf("--mcp-config") + 1]));
	assert.notEqual(secrets[0], dir);
	assert.notEqual(secrets[0], secrets[1]);
	if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("audit dir is created on demand", async () => {
	const root = join(tmpdir(), `claude-sub-audit-test-${process.pid}`);
	const audit = join(root, "nested");
	temps.push(root);
	const { message } = await run({ events: textAnswer("ok") }, [user("a")], { env: { CLAUDE_SUBSCRIPTION_AUDIT_DIR: audit } });
	assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
	assert.equal(readdirSync(audit).length, 1);
});

test("missing claude fails with the install hint", async () => {
	const s = streamClaudeCode(model, normalizeContext({ messages: [user("a")] }), { env: { CLAUDE_SUBSCRIPTION_COMMAND: "/nonexistent/claude" } });
	const message = await s.result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage!, /Claude Code is not installed/);
});

test("assistant prefill is refused", async () => {
	const s = streamClaudeCode(model, normalizeContext({ messages: [user("a"), { ...(await run({ events: textAnswer("x") }, [user("a")])).message }] }), {});
	assert.match((await s.result()).errorMessage!, /prefill/);
});

test("user text starting with a slash reaches the model instead of native's command handler", async () => {
	const { message, upstream } = await run({ events: textAnswer("ok") }, [user("/status"), { role: "user", content: [{ type: "text", text: "/cost now" }], timestamp: 2 }]);
	assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
	const sent = JSON.parse(upstream.bodies[0]);
	assert.deepEqual(sent.messages[0].content.map((b: any) => b.text), ["\n/status", "\n/cost now"]);
});
