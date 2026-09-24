/**
 * pi transcript -> Claude Code stream-json frames plus the generation fields native applies
 * from CLAUDE_CODE_EXTRA_BODY.
 *
 * Every historical user frame is replayed with `shouldQuery: false`; only the final user or
 * tool-result frame queries. Assistant turns this provider produced for the same model keep
 * their signed thinking; foreign or edited turns replay as plain text and tool-use blocks.
 */
import {
	type Api,
	type AssistantMessage,
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { makeStrictJsonSchema, resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { BUDGET, EFFORT, MIN_ANSWER_TOKENS, MIN_THINKING_BUDGET, route } from "./catalog.ts";

/** MCP server name; native exposes its tools as `mcp__pi__<name>`. */
export const SERVER = "pi";
export const PREFIX = `mcp__${SERVER}__`;

type Block = Record<string, any>;
interface Frame {
	type: "user" | "assistant";
	message: { role: "user" | "assistant"; content: Block[] };
	shouldQuery?: false;
}

export interface Prepared {
	system: string;
	frames: Frame[];
	/** JSON for CLAUDE_CODE_EXTRA_BODY. */
	extraBody: string;
	/** Inert MCP inventory. */
	manifest: { name: string; description: string; inputSchema: unknown }[];
	/** The current tool inventory; native may only return these. */
	toolNames: Set<string>;
	maxTokens: number | undefined;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,50}$/;
const TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function mediaBlocks(items: (TextContent | ImageContent)[]): Block[] {
	return items.flatMap((item): Block[] => {
		if (item.type === "text") return item.text.trim() ? [{ type: "text", text: item.text }] : [];
		return [{ type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } }];
	});
}

/**
 * Native answers user text beginning with one of its own command names (`/status`, `/cost`, ...)
 * locally, "isn't available in this environment", and never queries the model, even with
 * --disable-slash-commands. One leading newline stops that and reaches the model verbatim.
 */
function literalSlash(block: Block): Block {
	return block.type === "text" && block.text.startsWith("/") ? { ...block, text: `\n${block.text}` } : block;
}

function userBlocks(content: string | (TextContent | ImageContent)[]): Block[] {
	const items: (TextContent | ImageContent)[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
	return mediaBlocks(items).map(literalSlash);
}

function toolResult(id: string, content: Block[], isError: boolean): Block {
	return { type: "tool_result", tool_use_id: id, content: content.length ? content : [{ type: "text", text: "(empty)" }], is_error: isError };
}

/**
 * Anthropic requires `^[a-zA-Z0-9_-]{1,64}$` tool-use ids; ids minted by other providers
 * (OpenAI Responses) can be longer or contain `|`. Map them deterministically.
 */
function normalizeId(id: string, seen: Map<string, string>): string {
	if (TOOL_ID.test(id)) return id;
	let mapped = seen.get(id);
	if (!mapped) {
		mapped = `toolu_${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(-40)}_${seen.size}`;
		seen.set(id, mapped);
	}
	return mapped;
}

function assistantBlocks(msg: AssistantMessage, model: Model<Api>, ids: Map<string, string>): Block[] {
	const same = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
	const blocks: Block[] = [];
	for (const block of msg.content) {
		if (block.type === "text") {
			if (block.text.trim()) blocks.push({ type: "text", text: block.text });
		} else if (block.type === "thinking") {
			if (block.redacted) {
				if (same && block.thinkingSignature) blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
				continue;
			}
			if (same && block.thinkingSignature) {
				blocks.push({ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature });
			} else if (block.thinking.trim()) {
				blocks.push({ type: "text", text: block.thinking });
			}
		} else if (block.type === "toolCall") {
			blocks.push({ type: "tool_use", id: normalizeId(block.id, ids), name: PREFIX + block.name, input: block.arguments ?? {} });
		}
	}
	return blocks;
}

/**
 * Anthropic rejects top-level oneOf/allOf/anyOf in `input_schema`; handlers re-validate their
 * arguments, so those advisory combinators are dropped. TypeBox symbols vanish via JSON.
 */
function normalizeSchema(schema: unknown): Record<string, unknown> {
	const plain = JSON.parse(JSON.stringify(schema ?? { type: "object" })) as Record<string, unknown>;
	for (const key of ["oneOf", "allOf", "anyOf"]) {
		if (key in plain) {
			delete plain[key];
			plain.type ??= "object";
		}
	}
	if (plain.type === "object" && (typeof plain.properties !== "object" || plain.properties === null)) plain.properties = {};
	return plain;
}

export function prepare(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): Prepared {
	const transcript = collapseSystemMessages(context);
	const messages = transcript.messages;
	const system = getCurrentSystemPrompt(messages) ?? "";
	const toolNames = new Set<string>();
	const manifest: Prepared["manifest"] = [];
	const tools: Block[] = [];
	for (const tool of getCurrentTools(messages)) {
		if (!TOOL_NAME.test(tool.name)) throw new Error(`Tool name ${JSON.stringify(tool.name)} must be an ASCII identifier of at most 50 characters`);
		if (toolNames.has(tool.name)) throw new Error(`Duplicate tool name ${tool.name}`);
		toolNames.add(tool.name);
		// Tools that ask for constrained sampling (pi's bash, write) get strict schemas, as with pi's own Anthropic provider.
		const strict = resolveJsonSchemaStrictSampling(tool, true) === true;
		const schema = strict ? (makeStrictJsonSchema(tool.parameters) as Record<string, unknown>) : normalizeSchema(tool.parameters);
		// The inert manifest and the request body must advertise the same shape.
		manifest.push({ name: tool.name, description: tool.description, inputSchema: schema });
		tools.push({ name: PREFIX + tool.name, description: tool.description, ...(strict && { strict: true }), input_schema: schema });
	}

	const frames: Frame[] = [];
	const ids = new Map<string, string>();
	const pendingCalls = new Set<string>();
	const push = (role: "user" | "assistant", blocks: Block[]) => {
		if (!blocks.length) return;
		const last = frames.at(-1);
		if (role === "user" && last?.type === "user") last.message.content.push(...blocks);
		else frames.push({ type: role, message: { role, content: blocks } });
	};
	const closeOrphans = () => {
		// A tool_use without a result is invalid upstream; pi aborts can leave one behind.
		const orphans = [...pendingCalls].map((id) => toolResult(id, [{ type: "text", text: "No result provided" }], true));
		pendingCalls.clear();
		push("user", orphans);
	};
	for (const msg of messages as Message[]) {
		if (msg.role === "system") continue;
		if (msg.role === "user") {
			closeOrphans();
			push("user", userBlocks(msg.content));
		} else if (msg.role === "assistant") {
			closeOrphans();
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			const blocks = assistantBlocks(msg, model, ids);
			for (const b of blocks) if (b.type === "tool_use") pendingCalls.add(b.id);
			push("assistant", blocks);
		} else if (msg.role === "toolResult") {
			const id = ids.get(msg.toolCallId) ?? msg.toolCallId;
			if (!pendingCalls.delete(id)) continue; // result for a dropped (errored) assistant turn
			push("user", [toolResult(id, mediaBlocks(msg.content), msg.isError)]);
		}
	}
	closeOrphans();
	const last = frames.at(-1);
	if (!last || last.type !== "user") throw new Error("History must end in a user or tool-result message; assistant prefill is unsupported");
	frames.forEach((frame, i) => {
		if (frame.type === "user" && i < frames.length - 1) frame.shouldQuery = false;
	});

	const body: Record<string, unknown> = { tools };
	const r = route(model.id);
	let maxTokens = options.maxTokens;
	if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) throw new Error("maxTokens must be a positive integer");
	if (!options.reasoning) {
		if (!r?.alwaysThinks) {
			body.thinking = { type: "disabled" };
			// Native clear-thinking context edits are invalid when thinking is disabled.
			body.context_management = { edits: [] };
		}
	} else if (r?.adaptive === false) {
		const ceiling = r.maxTokens;
		maxTokens = Math.min((maxTokens ?? ceiling) + BUDGET[options.reasoning], ceiling);
		const budget = Math.min(BUDGET[options.reasoning], maxTokens - MIN_ANSWER_TOKENS);
		if (budget >= MIN_THINKING_BUDGET) body.thinking = { type: "enabled", budget_tokens: budget, display: "summarized" };
	} else {
		body.thinking = { type: "adaptive", display: "summarized" };
		body.output_config = { effort: EFFORT[options.reasoning] };
	}
	if (options.toolChoice === "none") body.tool_choice = { type: "none" };
	if (maxTokens !== undefined) body.max_tokens = maxTokens;
	return { system, frames, extraBody: JSON.stringify(body), manifest, toolNames, maxTokens };
}
