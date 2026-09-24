/**
 * pi `streamSimple` over Claude Code: one pi call = one fresh native process = one upstream request.
 *
 * pi events are driven straight from the admitted upstream SSE (captured by the relay), so
 * text, thinking and tool-call arguments stream exactly as the service produced them. The
 * terminal `done` is emitted only after native exits and the relay confirms a complete response.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	contentText,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { nativeModel } from "./catalog.ts";
import { PREFIX, prepare, SERVER } from "./history.ts";
import { BASE_ARGS, childEnv, INSTALL_HINT, killTree, resolveClaude, spawnNative, workDir } from "./native.ts";
import { Relay, type SseEvent } from "./relay.ts";

const DEFAULT_IDLE_MS = 180_000;

type Live = (TextContent | ThinkingContent | (ToolCall & { partialJson?: string })) & { index?: number };

/** Drops streaming-only bookkeeping before a block reaches pi. */
function seal(block: Live): void {
	delete block.index;
	if (block.type === "toolCall") delete block.partialJson;
}

function mapStop(reason: string | undefined, details: any): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return { stopReason: "stop" };
		case "max_tokens":
		case "model_context_window_exceeded":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return { stopReason: "error", errorMessage: details?.explanation || "The model refused to complete the request" };
		default:
			return { stopReason: "error", errorMessage: `Unhandled stop reason: ${reason}` };
	}
}

/** Upstream SSE -> pi assistant events. */
class Builder {
	started = false;
	complete = false;
	stopReason: string | undefined;
	stopDetails: unknown;
	streamError: string | undefined;
	unknownTool: string | undefined;
	private readonly blocks: Live[];
	private readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private readonly model: Model<Api>;
	private readonly toolNames: Set<string>;

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<Api>, toolNames: Set<string>) {
		this.output = output;
		this.stream = stream;
		this.model = model;
		this.toolNames = toolNames;
		this.blocks = output.content as Live[];
	}

	private usage(u: any): void {
		if (!u) return;
		const o = this.output.usage;
		if (typeof u.input_tokens === "number") o.input = u.input_tokens;
		if (typeof u.output_tokens === "number") o.output = u.output_tokens;
		if (typeof u.cache_read_input_tokens === "number") o.cacheRead = u.cache_read_input_tokens;
		if (typeof u.cache_creation_input_tokens === "number") o.cacheWrite = u.cache_creation_input_tokens;
		if (typeof u.cache_creation?.ephemeral_1h_input_tokens === "number") o.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens;
		o.totalTokens = o.input + o.output + o.cacheRead + o.cacheWrite;
		o.cost = calculateCost(this.model, o);
	}

	private at(index: number): number {
		return this.blocks.findIndex((b) => b.index === index);
	}

	event(event: SseEvent): void {
		switch (event.type) {
			case "message_start":
				this.output.responseId = event.message?.id;
				if (event.message?.model) this.output.responseModel = event.message.model;
				this.usage(event.message?.usage);
				if (!this.started) {
					this.started = true;
					this.stream.push({ type: "start", partial: this.output });
				}
				return;
			case "content_block_start": {
				const cb = event.content_block;
				if (cb.type === "text") {
					this.blocks.push({ type: "text", text: "", index: event.index });
					this.stream.push({ type: "text_start", contentIndex: this.blocks.length - 1, partial: this.output });
				} else if (cb.type === "thinking") {
					this.blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
					this.stream.push({ type: "thinking_start", contentIndex: this.blocks.length - 1, partial: this.output });
				} else if (cb.type === "redacted_thinking") {
					this.blocks.push({ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: cb.data, redacted: true, index: event.index });
					this.stream.push({ type: "thinking_start", contentIndex: this.blocks.length - 1, partial: this.output });
				} else if (cb.type === "tool_use") {
					const native = String(cb.name ?? "");
					const bare = native.startsWith(PREFIX) ? native.slice(PREFIX.length) : undefined;
					const name = bare !== undefined && this.toolNames.has(bare) ? bare : undefined;
					if (name === undefined) this.unknownTool ??= native;
					this.blocks.push({ type: "toolCall", id: cb.id, name: name ?? native, arguments: {}, partialJson: "", index: event.index });
					this.stream.push({ type: "toolcall_start", contentIndex: this.blocks.length - 1, partial: this.output });
				}
				return;
			}
			case "content_block_delta": {
				const i = this.at(event.index);
				const block = this.blocks[i];
				const d = event.delta;
				if (!block) return;
				if (d.type === "text_delta" && block.type === "text") {
					block.text += d.text;
					this.stream.push({ type: "text_delta", contentIndex: i, delta: d.text, partial: this.output });
				} else if (d.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += d.thinking;
					this.stream.push({ type: "thinking_delta", contentIndex: i, delta: d.thinking, partial: this.output });
				} else if (d.type === "signature_delta" && block.type === "thinking") {
					block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
				} else if (d.type === "input_json_delta" && block.type === "toolCall") {
					block.partialJson = (block.partialJson ?? "") + d.partial_json;
					this.stream.push({ type: "toolcall_delta", contentIndex: i, delta: d.partial_json, partial: this.output });
				}
				return;
			}
			case "content_block_stop": {
				const i = this.at(event.index);
				const block = this.blocks[i];
				if (!block) return;
				if (block.type === "toolCall") {
					// A no-argument call streams one empty partial_json.
					block.arguments = JSON.parse(block.partialJson?.trim() || "{}") as ToolCall["arguments"];
				}
				seal(block);
				if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: this.output });
				else if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: this.output });
				else this.stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: this.output });
				return;
			}
			case "message_delta":
				if (event.delta?.stop_reason) {
					this.stopReason = event.delta.stop_reason;
					this.stopDetails = event.delta.stop_details;
					this.output.rawStopReason = event.delta.stop_reason;
				}
				this.usage(event.usage);
				return;
			case "message_stop":
				this.complete = this.stopReason !== undefined && this.blocks.every((b) => b.index === undefined);
				return;
			case "error":
				this.streamError = event.error?.message ?? JSON.stringify(event.error);
				return;
		}
	}
}

function emptyOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

export function streamClaudeCode(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyOutput(model);
	run(model, context, options, stream, output).catch((error: unknown) => {
		for (const block of output.content as Live[]) seal(block);
		output.stopReason = options.signal?.aborted ? "aborted" : "error";
		output.errorMessage = options.signal?.aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	});
	return stream;
}

async function run(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions, stream: AssistantMessageEventStream, output: AssistantMessage): Promise<void> {
	const prepared = prepare(model, context, options);
	const { frames, system } = prepared;
	let extraBody = prepared.extraBody;

	// Instrumentation hook shared with built-in providers: inspect or replace the generation fields.
	const replaced = await options.onPayload?.(JSON.parse(extraBody), model);
	if (replaced !== undefined) extraBody = JSON.stringify(replaced);

	const env = { ...process.env, ...(options.env ?? {}) };
	const claude = resolveClaude(env);
	if (!claude) throw new Error(INSTALL_HINT);
	if (options.signal?.aborted) throw new Error("Request was aborted");

	const idleMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_IDLE_MS;
	const builder = new Builder(output, stream, model, prepared.toolNames);
	let touch = () => {};
	const audit = env.CLAUDE_SUBSCRIPTION_AUDIT_DIR;
	let audited: Promise<unknown> | undefined;
	const relay = await Relay.start({
		upstream: env.CLAUDE_SUBSCRIPTION_UPSTREAM,
		timeoutMs: idleMs,
		tools: prepared.manifest,
		// Debug only: CLAUDE_SUBSCRIPTION_AUDIT_DIR keeps the exact outbound bodies (full prompts) on disk.
		onForward: audit
			? (body) => {
					const file = join(audit, `request-${Date.now()}-${process.pid}.json`);
					audited = mkdir(audit, { recursive: true, mode: 0o700 })
						.then(() => writeFile(file, body, { mode: 0o600 }))
						.catch(() => {});
				}
			: undefined,
		onEvent: (event) => {
			touch();
			builder.event(event);
		},
	});
	const tmp = await mkdtemp(join(tmpdir(), "claude-subscription-"));
	let child: ReturnType<typeof spawnNative> | undefined;
	const onAbort = () => {
		relay.abort();
		if (child) killTree(child);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.all([
			writeFile(join(tmp, "system.md"), system, "utf8"),
			// Native applies settings env in-process, avoiding execve's per-string limits for big schemas.
			writeFile(join(tmp, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: extraBody } }), "utf8"),
			// The relay URL is the admission secret; argv is world-readable, the per-call private temp dir is not.
			writeFile(join(tmp, "mcp.json"), JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: relay.mcpUrl } } }), "utf8"),
		]);
		const childVars = childEnv(env, relay.url);
		Object.assign(childVars, {
			ENABLE_TOOL_SEARCH: "false",
			CLAUDE_CODE_MAX_RETRIES: "0",
			DISABLE_AUTO_COMPACT: "1",
			DISABLE_COMPACT: "1",
			// pi owns budgets; native's replayed reminder would invalidate cached history.
			CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
		});
		if (prepared.maxTokens !== undefined) childVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(prepared.maxTokens);
		const args = [
			...BASE_ARGS,
			"--model", nativeModel(model.id),
			"--system-prompt-file", join(tmp, "system.md"),
			"--settings", join(tmp, "settings.json"),
			"--mcp-config", join(tmp, "mcp.json"),
			"--max-turns", "1",
			"--permission-mode", "dontAsk",
		];
		child = spawnNative(claude, args, { cwd: await workDir(env), env: childVars });
		const proc = child;
		if (options.signal?.aborted) onAbort();
		let wake: (() => void) | undefined;
		let stderr = "";
		proc.stderr?.on("data", (c: Buffer) => {
			if (stderr.length < 8192) stderr += c.toString("utf8");
		});
		const detail = (text = stderr.trim().slice(0, 500)) => (text ? `: ${text}` : "");
		const exited = new Promise<number | null>((resolve) => proc.once("close", (code) => resolve(code)));
		let procError: Error | undefined;
		proc.on("error", (error) => {
			procError ??= error;
			wake?.();
		});

		// Native stdout as a queue; any activity resets the idle deadline.
		const lines: any[] = [];
		let ended = false;
		let parseError: Error | undefined;
		const rl = createInterface({ input: proc.stdout! });
		rl.on("line", (line) => {
			if (!line.trim()) return;
			try {
				lines.push(JSON.parse(line));
			} catch {
				parseError ??= new Error(`Invalid native stream-json output: ${JSON.stringify(line.slice(0, 300))}`);
			}
			wake?.();
		});
		rl.on("close", () => {
			ended = true;
			wake?.();
		});
		let deadline = Date.now() + idleMs;
		touch = () => {
			deadline = Date.now() + idleMs;
		};
		const next = async (): Promise<any | undefined> => {
			for (;;) {
				if (options.signal?.aborted) throw new Error("Request was aborted");
				if (procError) throw procError;
				if (parseError) throw parseError;
				if (lines.length) {
					touch();
					return lines.shift();
				}
				if (ended) return undefined;
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw new Error("Claude request timed out");
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, remaining);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
				wake = undefined;
			}
		};

		const write = (frame: unknown) =>
			new Promise<void>((resolve, reject) => proc.stdin!.write(`${JSON.stringify(frame)}\n`, () => (procError ? reject(procError) : resolve())));
		// One ack per frame before the next: native merges user frames queued ahead of its
		// drain into a single turn, reordering history (verified against claude 2.1.280).
		for (const frame of frames) {
			await write(frame);
			if (frame.shouldQuery !== false) continue;
			for (;;) {
				const ack = await next();
				if (ack === undefined) throw new Error(`Native exited before replay acknowledgment${detail()}`);
				if (ack.type === "result") {
					if (ack.num_turns !== 0 || ack.is_error) throw new Error("Native history replay not supported: expected zero-turn acknowledgment");
					break;
				}
			}
		}
		proc.stdin!.end();

		const results: any[] = [];
		let nativeError: string | undefined;
		for (;;) {
			const event = await next();
			if (event === undefined) break;
			if (event.type === "result") results.push(event);
			else if (event.type === "assistant" && (event.error || event.message?.error)) {
				nativeError = contentText(event.message?.content ?? []);
			}
		}
		const code = await exited;
		await audited;
		if (options.signal?.aborted) throw new Error("Request was aborted");

		if (!relay.used) {
			throw new Error(`Native made no upstream request (exit ${code})${detail(nativeError || undefined)}`);
		}
		await options.onResponse?.({ status: relay.status ?? 0, headers: relay.requestId ? { "request-id": relay.requestId } : {} }, model);
		if (relay.status !== 200 || !relay.finished || !builder.complete || builder.streamError) {
			const upstream = relay.errorText() || builder.streamError;
			const first = `status ${relay.status ?? "none"}, ${builder.complete ? "complete" : "incomplete"}${relay.failure ? `, relay: ${relay.failure}` : ""}, native retries denied: ${relay.denied}`;
			// Keep the upstream text verbatim: pi recognizes context overflow from it.
			throw new Error(upstream ? `${upstream} (${first})` : `Incomplete upstream response (${first})${detail(nativeError ?? "")}`);
		}
		if (builder.unknownTool) throw new Error(`Native returned a tool outside the current inventory: ${builder.unknownTool}`);
		const mapped = mapStop(builder.stopReason, builder.stopDetails);
		if (mapped.stopReason === "error") throw new Error(mapped.errorMessage);
		// Native's own outcome only matters when the response itself was not accepted; a
		// denied recovery attempt after a complete response is the expected boundary.
		if (results.length !== 1) throw new Error(`Incomplete native response: expected one result, got ${results.length}`);
		output.stopReason = mapped.stopReason;
		stream.push({ type: "done", reason: mapped.stopReason as "stop" | "length" | "toolUse", message: output });
		stream.end();
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		if (child) killTree(child);
		await relay.close();
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
	}
}
