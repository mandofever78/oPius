/**
 * Live qualification against the real subscription (costs a little allowance):
 *   node test/live.ts [model]
 * Two calls: a tool round and its follow-up, sent as native builds them plus the relay's history breakpoint.
 * Asserts one upstream request per call and prints the upstream outcome verbatim.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type Message, normalizeContext, type ToolCall, Type } from "@earendil-works/pi-ai";
import { API, BASE_URL, PROVIDER, STATIC_MODELS } from "../src/catalog.ts";
import { streamClaudeCode } from "../src/stream.ts";

const audit = mkdtempSync(join(tmpdir(), "claude-sub-audit-"));
process.env.CLAUDE_SUBSCRIPTION_AUDIT_DIR = audit;
const id = process.argv[2] ?? "claude-sonnet-5";
const cfg = STATIC_MODELS.find((m) => m.id === id)!;
const model = { ...cfg, api: API, provider: PROVIDER, baseUrl: BASE_URL } as any;
const tools = [{ name: "pi_echo", description: "Echo a message through pi. Always use it when asked to echo.", parameters: Type.Object({ pi_text: Type.String({ description: "text for pi" }) }) }];
const systemPrompt = "You are pi, a coding agent. The pi harness runs tools for you.";

async function call(messages: Message[], reasoning?: "low") {
	const s = streamClaudeCode(model, normalizeContext({ systemPrompt, tools, messages }), { reasoning });
	const kinds: string[] = [];
	for await (const e of s) kinds.push(e.type);
	const msg = (await s.result()) as AssistantMessage;
	console.log(kinds.filter((k, i) => k !== kinds[i - 1]).join(" "));
	console.log(JSON.stringify({ stop: msg.stopReason, err: msg.errorMessage, usage: msg.usage, content: msg.content }, null, 1).slice(0, 1500));
	return msg;
}

const user: Message = { role: "user", content: "Use the pi_echo tool to echo exactly: hello from Pi at ~/.pi/agent", timestamp: Date.now() };
const first = await call([user], "low");
assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "");
const tc = first.content.find((b): b is ToolCall => b.type === "toolCall")!;
assert.equal(tc.name, "pi_echo");
assert.ok("pi_text" in tc.arguments, "schema key restored");
const second = await call([user, first, { role: "toolResult", toolCallId: tc.id, toolName: "pi_echo", content: [{ type: "text", text: "echoed by pi: OK" }], isError: false, timestamp: Date.now() }], "low");
assert.equal(second.stopReason, "stop", second.errorMessage ?? "");

const bodies = readdirSync(audit).map((f) => readFileSync(join(audit, f), "utf8"));
assert.equal(bodies.length, 2, "exactly one upstream request per call");
assert.ok(bodies.every((b) => b.includes("You are pi")), "system prompt forwarded unchanged");
const followUp = JSON.parse(bodies[1]).messages.findLast((m: any) => m.role === "assistant");
assert.ok(followUp.content.at(-1).cache_control, "history breakpoint on the last assistant block");
console.log(`PASS: 2 calls, 2 upstream requests, history breakpoint added (audit: ${audit})`);
