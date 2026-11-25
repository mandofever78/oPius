/**
 * Request-scoped loopback relay between Claude Code and the Messages API.
 *
 * - Admission: only the first `POST /v1/messages` is forwarded upstream; native recovery
 *   attempts after it are refused locally, so one pi call is exactly one upstream request.
 * - Inventory: an inert MCP endpoint lists pi's tools so native recognizes them; calls to it are
 *   denied, because only pi executes tools.
 * - Privacy: native's account-email context reminder is removed from the admitted body.
 * - Caching: the admitted body gains one history cache breakpoint (`addHistoryBreakpoint`) and is
 *   otherwise forwarded as Claude Code builds it.
 *
 * Native authorization headers pass through memory to the upstream unchanged and are never logged.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { buffer } from "node:stream/consumers";
import { StringDecoder } from "node:string_decoder";

export type SseEvent = { type: string; [key: string]: any };

/** The API's limit on cache_control markers per request. */
const MAX_BREAKPOINTS = 4;

/**
 * Claude Code's only conversation breakpoint sits on a trailing system message that changes every
 * call, so history is never read from cache. Marking the last assistant block lets the next call
 * read everything up to it. Anything unexpected passes through untouched.
 */
export function addHistoryBreakpoint(body: Buffer): Buffer {
	return rewrite(body, markHistory);
}

/** Parse, apply each edit, and re-serialize only when one changed something. */
function rewrite(body: Buffer, ...edits: ((request: any) => boolean)[]): Buffer {
	let request: any;
	try {
		request = JSON.parse(body.toString("utf8"));
	} catch {
		return body;
	}
	let changed = false;
	for (const edit of edits) changed = edit(request) || changed;
	return changed ? Buffer.from(JSON.stringify(request), "utf8") : body;
}

const blocks = (list: unknown): any[] => (Array.isArray(list) ? list.filter((b) => b && typeof b === "object") : []);

const CONTEXT_HEAD = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n";
const CONTEXT_TAIL = /Claude Code attached this context automatically;[^\n]*\n<\/system-reminder>\n?$/;

/**
 * Removes the `# userEmail` section from a native context reminder; the whole block goes when
 * nothing else is left. `undefined` means the block is not native's context reminder.
 */
function withoutEmail(text: string): string | null | undefined {
	if (!text.startsWith(CONTEXT_HEAD) || !CONTEXT_TAIL.test(text)) return undefined;
	const sections = text.slice(CONTEXT_HEAD.length).replace(CONTEXT_TAIL, "").split(/(?=^# )/m);
	const kept = sections.filter((s) => !s.startsWith("# userEmail\n"));
	if (kept.length === sections.length) return undefined;
	if (!kept.join("").trim()) return null;
	return CONTEXT_HEAD + kept.join("") + text.match(CONTEXT_TAIL)![0];
}

/**
 * Claude Code attaches the account email as a context reminder to the latest user turn: after its
 * last tool result, or ahead of its text. pi never asked for it, and the model repeats it into
 * transcripts. Only those positions (and the first user turn) are checked, so reminders the user
 * wrote themselves pass untouched.
 */
function dropAccountEmail(request: any): boolean {
	const messages = blocks(request?.messages);
	const first = messages.find((m) => m.role === "user");
	const last = messages.findLast((m) => m.role === "user");
	const slots: any[][] = [];
	for (const m of new Set([first, last])) if (Array.isArray(m?.content)) slots.push(m.content);
	for (const b of blocks(last?.content)) if (b.type === "tool_result" && Array.isArray(b.content)) slots.push(b.content);
	let changed = false;
	for (const list of slots) {
		for (const index of [0, list.length - 1]) {
			const block = list[index];
			if (block?.type !== "text" || typeof block.text !== "string" || list.length < 2) continue;
			const text = withoutEmail(block.text);
			if (text === undefined) continue;
			if (text === null) list.splice(index, 1);
			else block.text = text;
			changed = true;
			break;
		}
	}
	return changed;
}

/** The admitted body as forwarded: account email removed, history breakpoint added. */
export function prepareBody(body: Buffer): Buffer {
	return rewrite(body, dropAccountEmail, markHistory);
}

function markHistory(request: any): boolean {
	const messages = blocks(request?.messages);
	const content = messages.flatMap((m) => blocks(m.content));
	const all = [...blocks(request?.system), ...blocks(request?.tools), ...content, ...content.flatMap((b) => blocks(b.content))];
	if (all.filter((b) => b.cache_control).length >= MAX_BREAKPOINTS) return false;
	const last = blocks(messages.findLast((m) => m.role === "assistant")?.content).findLast((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
	if (!last || last.cache_control) return false;
	last.cache_control = { type: "ephemeral", ttl: "1h" };
	return true;
}

const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "proxy-connection", "accept-encoding", "keep-alive"]);
const RESPONSE_HOP = new Set(["connection", "transfer-encoding", "server", "date", "content-length", "keep-alive"]);

function copyHeaders(source: http.IncomingHttpHeaders, drop: Set<string>): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(source)) if (value !== undefined && !drop.has(key)) out[key] = value;
	return out;
}

class SseParser {
	private pending = "";
	private readonly decoder = new StringDecoder("utf8");
	private readonly onEvent: (event: SseEvent) => void;
	constructor(onEvent: (event: SseEvent) => void) {
		this.onEvent = onEvent;
	}

	feed(chunk: Buffer): void {
		this.pending += this.decoder.write(chunk);
		for (;;) {
			const match = /\r?\n\r?\n/.exec(this.pending);
			if (!match) return;
			const frame = this.pending.slice(0, match.index);
			this.pending = this.pending.slice(match.index + match[0].length);
			this.emit(frame);
		}
	}

	/** At EOF a final frame may lack its blank-line terminator. */
	flush(): void {
		const frame = this.pending + this.decoder.end();
		this.pending = "";
		if (frame.trim()) this.emit(frame);
	}

	private emit(frame: string): void {
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data) this.onEvent(JSON.parse(data));
	}
}

interface RelayOptions {
	upstream?: string;
	/** Idle timeout in ms for both legs of the forwarded request. */
	timeoutMs: number;
	/** Tool manifest served by the inert MCP endpoint (native-facing names). */
	tools: { name: string; description: string; inputSchema: unknown }[];
	/** Upstream SSE events of the admitted response, in order, as they arrive. */
	onEvent?: (event: SseEvent) => void;
	/** Sees the exact bytes about to be sent upstream (audits and tests). */
	onForward?: (body: Buffer) => void;
}

export class Relay {
	private readonly prefix = `/admit/${randomBytes(32).toString("base64url")}`;
	private readonly server: http.Server;
	private readonly upstream: URL;
	private readonly sockets = new Set<Socket>();
	private cancelled = false;
	used = false;
	denied = 0;
	status: number | undefined;
	requestId: string | undefined;
	failure: string | undefined;
	/** The admitted response ended without being aborted mid-stream. */
	finished = false;
	errorBody = "";

	private readonly options: RelayOptions;

	private constructor(options: RelayOptions) {
		this.options = options;
		this.upstream = new URL(options.upstream ?? "https://api.anthropic.com");
		const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(this.upstream.hostname);
		if (!(this.upstream.protocol === "https:" || (this.upstream.protocol === "http:" && loopback)) || this.upstream.username || this.upstream.password || this.upstream.search || this.upstream.hash) {
			throw new Error("Native upstream must be HTTPS or a loopback HTTP fixture");
		}
		this.server = http.createServer((req, res) => {
			this.handle(req, res).catch((error: Error) => {
				this.failure ??= error.message;
				res.destroy();
			});
		});
		this.server.on("connection", (socket) => this.track(socket));
	}

	static async start(options: RelayOptions): Promise<Relay> {
		const relay = new Relay(options);
		await new Promise<void>((resolve, reject) => {
			relay.server.once("error", reject);
			relay.server.listen(0, "127.0.0.1", () => resolve());
		});
		return relay;
	}

	get url(): string {
		const { port } = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${port}${this.prefix}`;
	}

	get mcpUrl(): string {
		return `${this.url}/mcp`;
	}

	/** The upstream's own message for a non-200 answer, "" when none was captured. */
	errorText(): string {
		try {
			const message = JSON.parse(this.errorBody).error.message;
			return typeof message === "string" ? message : this.errorBody;
		} catch {
			return this.errorBody;
		}
	}

	private track(socket: Socket): void {
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
	}

	abort(): void {
		this.cancelled = true;
		for (const socket of this.sockets) socket.destroy();
	}

	async close(): Promise<void> {
		this.abort();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://relay");
		if (req.method !== "POST" || req.headers.origin || !path.pathname.startsWith(`${this.prefix}/`)) {
			res.writeHead(404).end();
			req.resume();
			return;
		}
		const body = await buffer(req);
		if (path.pathname === `${this.prefix}/mcp`) return this.mcp(body, res);
		if (path.pathname !== `${this.prefix}/v1/messages`) {
			res.writeHead(404).end();
			return;
		}
		if (this.cancelled || this.used) {
			this.denied++;
			return deny(res, "PI_MODEL_ADMISSION_CONSUMED");
		}
		this.used = true;
		const payload = prepareBody(body);
		this.options.onForward?.(payload);
		this.forward(req, path.search, payload, res);
	}

	private forward(req: http.IncomingMessage, search: string, payload: Buffer, res: http.ServerResponse): void {
		const headers = copyHeaders(req.headers, HOP);
		headers["accept-encoding"] = "identity";
		headers["content-length"] = String(payload.length);
		const target = this.upstream;
		const client = target.protocol === "https:" ? https : http;
		const upstream = client.request(
			{
				hostname: target.hostname.replace(/^\[|\]$/g, ""),
				port: target.port || undefined,
				method: "POST",
				path: `${target.pathname.replace(/\/$/, "")}/v1/messages${search}`,
				headers,
				timeout: this.options.timeoutMs,
			},
			(response) => {
				this.status = response.statusCode;
				const id = response.headers["request-id"] ?? response.headers["x-request-id"];
				this.requestId = Array.isArray(id) ? id[0] : id;
				const out = copyHeaders(response.headers, RESPONSE_HOP);
				out.connection = "close";
				res.writeHead(response.statusCode ?? 502, out);
				const parser = this.status === 200 ? new SseParser((event) => this.options.onEvent?.(event)) : undefined;
				response.on("data", (chunk: Buffer) => {
					try {
						if (parser) parser.feed(chunk);
						else if (this.errorBody.length < 65536) this.errorBody += chunk.toString("utf8");
					} catch (error) {
						this.failure = `stream parse: ${(error as Error).message}`;
						upstream.destroy();
						res.destroy();
						return;
					}
					res.write(chunk);
				});
				response.on("end", () => {
					if (!response.readableAborted) {
						try {
							parser?.flush();
						} catch (error) {
							this.failure = `stream parse: ${(error as Error).message}`;
							res.destroy();
							return;
						}
						this.finished = true;
					}
					res.end();
				});
				response.on("error", (error) => {
					this.failure ??= error.name;
					res.destroy();
				});
			},
		);
		upstream.on("socket", (socket) => {
			this.track(socket);
			if (this.cancelled) socket.destroy();
		});
		upstream.on("timeout", () => upstream.destroy(new Error("upstream idle timeout")));
		upstream.on("error", (error) => {
			this.failure ??= error.message;
			if (!res.headersSent) res.writeHead(502).end();
			else res.destroy();
		});
		upstream.end(payload);
	}

	/** Streamable-HTTP MCP, JSON responses only. Inventory, never execution. */
	private mcp(body: Buffer, res: http.ServerResponse): void {
		let row: any;
		try {
			row = JSON.parse(body.toString("utf8"));
		} catch {
			res.writeHead(400).end();
			return;
		}
		if (Array.isArray(row) || row?.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		let result: unknown = {};
		if (row.method === "initialize") {
			result = { protocolVersion: row.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi-inert-inventory", version: "1" } };
		} else if (row.method === "tools/list") {
			result = { tools: this.options.tools };
		} else if (row.method === "tools/call") {
			result = { isError: true, content: [{ type: "text", text: "Denied: native tools are inert; only pi executes tools." }] };
		}
		sendJson(res, 200, { jsonrpc: "2.0", id: row.id, result });
	}
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
}

function deny(res: http.ServerResponse, message: string): void {
	sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message } });
}
