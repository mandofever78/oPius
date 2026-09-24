import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { addHistoryBreakpoint, Relay, type SseEvent } from "../src/relay.ts";
import { textAnswer } from "./fixtures/upstream.ts";

/** Upstream that writes `body` verbatim as its SSE answer. */
async function rawUpstream(body: string) {
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(body);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

async function relayed(body: string) {
	const upstream = await rawUpstream(body);
	const events: SseEvent[] = [];
	const relay = await Relay.start({ upstream: upstream.url, timeoutMs: 5000, tools: [], onEvent: (e) => events.push(e) });
	try {
		const text = await fetch(`${relay.url}/v1/messages`, { method: "POST", body: "{}" }).then(
			(res) => res.text(),
			() => undefined,
		);
		return { events, relay, text };
	} finally {
		await relay.close();
		await upstream.close();
	}
}

const frames = (events: object[]) => events.map((e) => `event: ${(e as SseEvent).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("final frame without trailing blank line is delivered at EOF", async () => {
	const answer = textAnswer("hello");
	const body = frames(answer).replace(/\n$/, "");
	const { events, relay, text } = await relayed(body);
	assert.equal(text, body);
	assert.deepEqual(events, answer);
	assert.equal(events.at(-1)?.type, "message_stop");
	assert.equal(relay.finished, true);
	assert.equal(relay.failure, undefined);
});

test("terminated stream delivers each event exactly once", async () => {
	const answer = textAnswer("hello");
	const { events, relay } = await relayed(frames(answer));
	assert.deepEqual(events, answer);
	assert.equal(relay.finished, true);
});

test("unparseable trailing frame fails instead of finishing", async () => {
	const { relay } = await relayed(`${frames(textAnswer("hi"))}data: {oops`);
	assert.equal(relay.finished, false);
	assert.match(relay.failure ?? "", /^stream parse:/);
});

const EPHEMERAL = { type: "ephemeral", ttl: "1h" };
const breakpoint = (request: object) => JSON.parse(addHistoryBreakpoint(Buffer.from(JSON.stringify(request))).toString("utf8"));
const count = (value: unknown): number => (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;

test("history breakpoint lands once on the last assistant block that is not thinking", () => {
	const request = {
		system: [{ type: "text", text: "s", cache_control: EPHEMERAL }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "a" }] },
			{ role: "assistant", content: [{ type: "text", text: "old" }] },
			{ role: "user", content: [{ type: "text", text: "b" }] },
			{ role: "assistant", content: [{ type: "text", text: "t" }, { type: "tool_use", id: "t1", name: "x", input: {} }, { type: "thinking", thinking: "", signature: "s" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
			{ role: "system", content: [{ type: "text", text: "reminder", cache_control: EPHEMERAL }] },
		],
	};
	const sent = breakpoint(request);
	assert.equal(count(sent), 3);
	assert.deepEqual(sent.messages[3].content[1].cache_control, EPHEMERAL);
	delete sent.messages[3].content[1].cache_control;
	assert.deepEqual(sent, request, "nothing else changes");
});

test("a body already at four cache breakpoints is forwarded byte for byte", () => {
	const marked = { type: "text", text: "x", cache_control: EPHEMERAL };
	const body = Buffer.from(JSON.stringify({
		system: [marked, marked],
		tools: [{ name: "t", input_schema: {}, cache_control: EPHEMERAL }],
		messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [marked] }] }, { role: "assistant", content: [{ type: "text", text: "a" }] }],
	}));
	assert.equal(addHistoryBreakpoint(body), body);
});

test("invalid JSON and bodies without an assistant turn pass through", () => {
	const invalid = Buffer.from("{not json");
	assert.equal(addHistoryBreakpoint(invalid), invalid);
	const first = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
	assert.equal(addHistoryBreakpoint(first), first);
});
