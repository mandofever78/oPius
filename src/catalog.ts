/**
 * Pinned native routes. Claude Code applies gateway defaults once ANTHROPIC_BASE_URL points at
 * the relay, so 1M routes must be selected explicitly with the `[1m]` suffix.
 * Costs are Anthropic list prices per million tokens (from pi-ai's own catalog): pi reports a
 * list-price equivalent, not a subscription charge.
 */
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER = "claude-subscription";
export const API = "claude-code-cli";
/** Routing metadata only: requests go through the relay Claude Code is pointed at. */
export const BASE_URL = "process://claude-code";

interface Route {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	cost: ProviderModelConfig["cost"];
	/** Route accepts adaptive thinking and `output_config.effort`; Haiku 4.5 needs a token budget instead. */
	adaptive: boolean;
	/** Route rejects `thinking: {type: "disabled"}`, so pi's "off" level is unavailable. */
	alwaysThinks: boolean;
	/** Billed to usage credits from the first request on plans below Max. */
	creditsBelowMax?: true;
}

/** Order is the provider's model order: pi lists and falls back to the first entry, so Opus 5.5 leads. */
export const ROUTES: readonly Route[] = [
	{ id: "claude-opus-5-5", name: "Opus 5.5", contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, adaptive: true, alwaysThinks: true },
	{ id: "claude-sonnet-5", name: "Sonnet 5", contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, adaptive: true, alwaysThinks: false },
	{ id: "claude-opus-5", name: "Opus 5", contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, adaptive: true, alwaysThinks: true },
	{ id: "claude-opus-4-8", name: "Opus 4.8", contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, adaptive: true, alwaysThinks: false },
	{ id: "claude-fable-5-1", name: "Fable 5.1", contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, adaptive: true, alwaysThinks: true, creditsBelowMax: true },
	{ id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", contextWindow: 200_000, maxTokens: 64_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, adaptive: false, alwaysThinks: false },
];

const ALIASES: Readonly<Record<string, string>> = {
	sonnet: "claude-sonnet-5",
	haiku: "claude-haiku-4-5-20251001",
	"claude-haiku-4-5": "claude-haiku-4-5-20251001",
	opus: "claude-opus-5-5",
	fable: "claude-fable-5-1",
};

export function route(model: string): Route | undefined {
	const base = model.replace(/\[1m\]$/, "");
	const id = ALIASES[base] ?? base;
	return ROUTES.find((r) => r.id === id);
}

/** The `--model` argument: pinned 1M routes get `[1m]`; unknown ids pass through unchanged. */
export function nativeModel(model: string): string {
	const r = route(model);
	if (!r) return model;
	if (r.contextWindow === 1_000_000) return `${r.id}[1m]`;
	if (model.endsWith("[1m]")) throw new Error(`${r.name} does not support a 1M context window`);
	return r.id;
}

/** pi thinking level -> native effort. Native has no "minimal"; low is its floor. */
export const EFFORT: Readonly<Record<ThinkingLevel, string>> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** Thinking budgets for non-adaptive routes (Haiku 4.5), matching pi-ai's own defaults. */
export const BUDGET: Readonly<Record<ThinkingLevel, number>> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 16384,
};
export const MIN_THINKING_BUDGET = 1024;
export const MIN_ANSWER_TOKENS = 1024;

export function modelConfig(r: Route, note = ""): ProviderModelConfig {
	return {
		id: r.id,
		name: `${r.name} (Claude subscription${note ? ` · ${note}` : ""})`,
		reasoning: true,
		thinkingLevelMap: r.alwaysThinks ? { off: null, minimal: null } : { minimal: null },
		input: ["text", "image"],
		cost: r.cost,
		contextWindow: r.contextWindow,
		maxTokens: r.maxTokens,
	};
}

export const STATIC_MODELS: ProviderModelConfig[] = ROUTES.map((r) => modelConfig(r));
