/**
 * Claude Subscription (Claude Code CLI) — pi provider extension.
 *
 * Drives the unmodified official `claude` executable as a request-scoped model client for a
 * Claude Pro/Max subscription. pi keeps its own agent loop, tools, approvals and compaction.
 * Ported from NousResearch/hermes-plugin-claude-subscription-directsdk.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API, BASE_URL, PROVIDER, STATIC_MODELS } from "./src/catalog.ts";
import { discoverModels } from "./src/discover.ts";
import { authStatus, INSTALL_HINT, LOGIN_HINT, resolveClaude } from "./src/native.ts";
import { streamClaudeCode } from "./src/stream.ts";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		name: "Claude Subscription (Claude Code)",
		baseUrl: BASE_URL,
		// Not a credential. pi lists a provider only once it has auth; the real auth is
		// Claude Code's own login, which this extension never reads.
		apiKey: "claude-code-cli",
		api: API,
		models: STATIC_MODELS,
		streamSimple: streamClaudeCode,
		async refreshModels(context) {
			if (!context.allowNetwork) return STATIC_MODELS;
			return (await discoverModels(process.env, context.signal)) ?? STATIC_MODELS;
		},
	});

	pi.registerCommand("claude-subscription", {
		description: "Show Claude Code login status for the Claude Subscription provider",
		handler: async (_args, ctx) => {
			const status = await authStatus();
			if (!status.available) ctx.ui.notify(INSTALL_HINT, "error");
			else if (!status.loggedIn) ctx.ui.notify(LOGIN_HINT, "warning");
			else if (status.method && status.method !== "claude.ai" && !status.plan) {
				ctx.ui.notify(`Claude Code is logged in with "${status.method}", not a Claude subscription: requests would bill that account. Run \`claude auth login --claudeai\`.`, "warning");
			} else ctx.ui.notify(`Claude Code: logged in${status.plan ? ` (Claude ${status.plan})` : ""} via ${resolveClaude(process.env)}`, "info");
		},
	});
}
