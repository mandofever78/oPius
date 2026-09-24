/** Loopback stand-in for api.anthropic.com that records bodies and replays a scripted SSE answer. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { text as readText } from "node:stream/consumers";

export type Script = { status?: number; events?: object[]; error?: string };

export async function fakeUpstream(script: Script) {
	const bodies: string[] = [];
	const paths: string[] = [];
	const server = http.createServer(async (req, res) => {
		bodies.push(await readText(req));
		paths.push(req.url ?? "");
		if (script.status && script.status !== 200) {
			res.writeHead(script.status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: script.error ?? "bad" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_fake" });
		for (const e of script.events ?? []) res.write(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`);
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		bodies,
		paths,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

export function textAnswer(text: string, usage = { input_tokens: 10, output_tokens: 5 }): object[] {
	return [
		{ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", role: "assistant", content: [], usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 3) } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(3) } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } },
		{ type: "message_stop" },
	];
}

export function toolAnswer(name: string, input: object): object[] {
	const json = JSON.stringify(input);
	return [
		{ type: "message_start", message: { id: "msg_2", model: "claude-sonnet-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me call it." } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig+pi/abc" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(5) } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
		{ type: "message_stop" },
	];
}
