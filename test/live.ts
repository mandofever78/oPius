/**
 * Live qualification against the real subscription (costs a little allowance):
 *   node test/live.ts [model]
 * Three calls: a tool round, its follow-up, and a plain user follow-up, sent as native builds them plus the relay's history breakpoint.
 * Asserts one upstream request per call, no account email forwarded, and prints the upstream outcome verbatim.
 * Re-run after each Claude Code update and before each release.
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
// A plain follow-up: native attaches its context reminder to the latest user turn.
const third = await call([user, first, { role: "toolResult", toolCallId: tc.id, toolName: "pi_echo", content: [{ type: "text", text: "echoed by pi: OK" }], isError: false, timestamp: Date.now() }, second, { role: "user", content: "Reply with one word: thanks", timestamp: Date.now() }]);
assert.equal(third.stopReason, "stop", third.errorMessage ?? "");

const bodies = readdirSync(audit).sort().map((f) => readFileSync(join(audit, f), "utf8"));
assert.equal(bodies.length, 3, "exactly one upstream request per call");
assert.ok(bodies.every((b) => b.includes("You are pi")), "system prompt forwarded unchanged");
// Fails when native rewords its context reminder and the relay's filter stops matching.
assert.ok(bodies.every((b) => !b.includes("userEmail")), "account email never forwarded");
const followUp = JSON.parse(bodies[1]).messages.findLast((m: any) => m.role === "assistant");
assert.ok(followUp.content.at(-1).cache_control, "history breakpoint on the last assistant block");
console.log(`PASS: 3 calls, 3 upstream requests, no account email, history breakpoint added (audit: ${audit})`);
