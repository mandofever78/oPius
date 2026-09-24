/** Locating and launching the official Claude Code CLI; the provider never touches its credentials. */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const INSTALL_HINT =
	"Claude Code is not installed (no `claude` on PATH). Install it with `npm install -g @anthropic-ai/claude-code` or set CLAUDE_SUBSCRIPTION_COMMAND to the binary.";
export const LOGIN_HINT = "Claude Code is installed but not logged in. Run `claude auth login`, then retry.";

/** Overrides that would make native bill an API key or another backend instead of the subscription. */
const CONFLICTS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_EXTRA_BODY"];

export type Env = Record<string, string | undefined>;

/** Headless stream-json with every native tool, setting source, command and session store off. */
export const BASE_ARGS = [
	"-p",
	"--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
	"--tools", "",
	"--setting-sources", "",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--no-session-persistence",
];

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveClaude(env: Env): string | undefined {
	const head = env.CLAUDE_SUBSCRIPTION_COMMAND || "claude";
	if (isAbsolute(head)) return executable(head) ? head : undefined;
	const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		for (const ext of exts) {
			const candidate = join(dir, head + ext);
			if (dir && executable(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * The child's environment: pi's own Anthropic credentials and backend overrides are removed
 * rather than refused, since pi users routinely export them for pi's built-in provider.
 */
export function childEnv(env: Env, baseUrl?: string): Record<string, string> {
	const child: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v !== undefined && !CONFLICTS.includes(k) && !k.startsWith("CLAUDE_SUBSCRIPTION_")) child[k] = v;
	}
	if (env.CLAUDE_SUBSCRIPTION_CONFIG_DIR) child.CLAUDE_CONFIG_DIR = env.CLAUDE_SUBSCRIPTION_CONFIG_DIR;
	if (baseUrl) child.ANTHROPIC_BASE_URL = baseUrl;
	Object.assign(child, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
	return child;
}

/** Native plus every descendant; on POSIX the group outlives its leader, so it is always signalled. */
export function killTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		if (child.exitCode !== null || child.signalCode !== null) return;
		spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// ESRCH: the whole group is gone.
	}
}

/**
 * Native's working directory. Claude Code echoes it into every request's environment reminder, so a
 * per-call path would change the prompt prefix and defeat caching. Per-user and private, because a
 * shared path could be pre-created by another local user.
 */
export async function workDir(env: Env): Promise<string> {
	const base = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
	const dir = join(base, "pi-claude-subscription", "cwd");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const st = await lstat(dir);
	const owned = process.platform === "win32" || st.uid === process.getuid?.();
	if (!st.isDirectory() || !owned) throw new Error(`Refusing to run Claude Code in ${dir}: not a real directory owned by the current user`);
	return dir;
}

export function spawnNative(command: string, args: string[], { cwd, env, stderr = "pipe" }: { cwd: string; env: Record<string, string>; stderr?: "pipe" | "ignore" }): ChildProcess {
	const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", stderr], detached: process.platform !== "win32", windowsHide: true });
	// EPIPE when native exits early; callers report its exit and stderr instead.
	child.stdin!.on("error", () => {});
	return child;
}

export interface AuthStatus {
	available: boolean;
	loggedIn: boolean;
	plan: string;
	/** "claude.ai" for a subscription login; "console" logins bill API usage instead. */
	method: string;
}

export async function authStatus(env: Env = process.env, timeoutMs = 20_000): Promise<AuthStatus> {
	const claude = resolveClaude(env);
	if (!claude) return { available: false, loggedIn: false, plan: "", method: "" };
	let auth: Record<string, unknown> = {};
	try {
		// Logged out, `auth status` exits non-zero but still prints JSON.
		const run = await execFileAsync(claude, ["auth", "status"], { env: childEnv(env), encoding: "utf8", timeout: timeoutMs }).catch((error) => error);
		auth = JSON.parse(run.stdout ?? "");
	} catch {}
	return { available: true, loggedIn: auth.loggedIn === true, plan: String(auth.subscriptionType ?? ""), method: String(auth.authMethod ?? "") };
}
