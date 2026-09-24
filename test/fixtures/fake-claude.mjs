#!/usr/bin/env node
// Stand-in for the Claude Code CLI: speaks just enough stream-json, sends the replayed history to
// ANTHROPIC_BASE_URL like native does, then attempts one native "recovery" request that the
// relay must refuse. FAKE_CLAUDE_LOG receives argv and each request outcome.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (row) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(row) + "\n");
const argv = process.argv.slice(2);
const out = (row) => process.stdout.write(JSON.stringify(row) + "\n");
log({ argv, cwd: process.cwd(), env: { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY ?? null } });

if (argv[0] === "auth") {
	out({ loggedIn: true, subscriptionType: "pro" });
	process.exit(0);
}
const flag = (name) => argv[argv.indexOf(name) + 1];
const system = readFileSync(flag("--system-prompt-file"), "utf8");
const extra = JSON.parse(JSON.parse(readFileSync(flag("--settings"), "utf8")).env.CLAUDE_CODE_EXTRA_BODY);
const messages = [];
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	const frame = JSON.parse(line);
	if (frame.type === "control_request") {
		out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { models: [] } } });
		continue;
	}
	messages.push(frame.message);
	if (frame.shouldQuery === false) out({ type: "result", subtype: "success", num_turns: 0, is_error: false });
}
const body = { model: flag("--model"), system: [{ type: "text", text: "Claude Code preamble mentions pi too" }, { type: "text", text: system }], messages, ...extra, stream: true };
const post = (payload) => fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-oauth" }, body: JSON.stringify(payload) });
const first = await post(body);
const text = await first.text();
log({ status: first.status, bytes: text.length });
if (first.status !== 200) {
	out({ type: "assistant", error: "api_error", message: { content: [{ type: "text", text: `API Error: ${first.status}` }] } });
	out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1 });
	process.exit(1);
}
const recovery = await post(body);
log({ status: recovery.status, body: await recovery.text() });
out({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.01 });
