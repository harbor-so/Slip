/**
 * PID 1 inside a Harbor sandbox: bring the box up, then hand it to the bridge.
 *
 * This file executes effects. It decides nothing — every branch it takes comes
 * from `boot-decisions.ts`, which is pure and tested at its boundaries with no
 * mocks. The split is the point, and it is a direct response to the reference
 * implementation this project replaces: 2,523 lines in one class, with boot-mode
 * branching at roughly fifteen scattered call sites. Nobody there can answer
 * "what does a snapshot_restore boot actually do" without reading all fifteen, so
 * nobody does, so the least observable component in the system is also the one
 * that runs first and blames the repository when it goes wrong.
 *
 * The boot sequence, in order, once:
 *
 *   1. Resolve **exactly one** boot mode and export it as `HARBOR_BOOT_MODE`, so
 *      repository hooks can branch on the same answer this process used.
 *   2. Point git at the credential helper, so a clone of a private repository
 *      works without a token ever being written to disk.
 *   3. Clone the session's repositories side by side under `/workspace/<name>`.
 *   4. `.harbor/setup.sh` — fresh boots only, **non-fatal**.
 *   5. Wait for tunnel URLs, bounded, then proceed either way.
 *   6. `.harbor/start.sh` — every boot, **fatal**.
 *   7. Report ready, and serve commands until told to stop.
 *
 * Warnings collected along the way go to a file **and** over the bridge. Only the
 * second one matters in practice: nobody reads a sandbox's log, and a box that
 * came up degraded needs to say so on the surface the user is already looking at.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { setting, validateConfig } from "../src/config.js";
import type {
	AgentAdapter,
	AgentInterrupt,
	AgentRuntime,
	AgentTurnRequest,
	AgentUsage,
} from "../src/contracts/agent.js";
import { AGENT_RUNTIMES } from "../src/contracts/agent.js";
import type { BootMode } from "../src/contracts/index.js";
import { adapterFor, stripAnsi, usageAccumulationFor } from "./adapters/index.js";
import {
	TUNNEL_ENV_PATH,
	assertNever,
	hookPolicy,
	resolveBootMode,
	tunnelFileDecision,
	tunnelWaitVerdict,
	type BootWarning,
	type HookName,
} from "./boot-decisions.js";
import { Bridge, defaultBridgeDeps, type BridgeHandlers, type TurnInvocation } from "./bridge.js";

/** Where boot warnings are written so a human on the box can find them. */
export const BOOT_WARNINGS_PATH = "/workspace/.harbor/boot-warnings.json";

export interface RepoSpec {
	/** Directory name under the workspace root. Also the git remote's short name. */
	name: string;
	url: string;
	/** Branch or SHA to check out. Absent means the remote's default branch. */
	ref?: string;
}

export interface SupervisorConfig {
	controlUrl: string;
	sandboxId: string;
	sessionId: string;
	token: string;
	/** The spawn attempt's fence. Presented on every privileged call to the control plane. */
	fencingToken: number;
	traceId?: string;
	runtime: AgentRuntime;
	workspaceRoot: string;
	repos: RepoSpec[];
	requestedBootMode: string | null;
}

export type ConfigResolution =
	| { kind: "ok"; config: SupervisorConfig }
	| { kind: "invalid"; problems: string[] };

/**
 * Read the boot contract out of the environment, or list everything that is wrong.
 *
 * All problems at once rather than the first one, because the feedback loop is a
 * container rebuild: reporting one missing variable per boot turns a
 * five-variable misconfiguration into five builds. This is the same reason
 * `validateConfig()` collects rather than throws on the first check.
 *
 * `HARBOR_REPOS` is JSON rather than a delimited string because a git URL can
 * contain almost any punctuation, and every delimiter someone picks is legal in
 * some URL. The failure of the delimited version is a clone against a truncated
 * URL, which reads as "that repository does not exist".
 */
export function readSupervisorConfig(env: NodeJS.ProcessEnv): ConfigResolution {
	const problems: string[] = [];
	const required = (name: string): string => {
		const value = env[name];
		if (value === undefined || value.trim() === "") {
			problems.push(`${name} is not set. The control plane must inject it when spawning the box.`);
			return "";
		}
		return value.trim();
	};

	const controlUrl = required("HARBOR_CONTROL_URL").replace(/\/+$/, "");
	const sandboxId = required("HARBOR_SANDBOX_ID");
	const sessionId = required("HARBOR_SESSION_ID");
	const token = required("HARBOR_SANDBOX_TOKEN");

	const fenceRaw = (env.HARBOR_FENCING_TOKEN ?? "").trim();
	const fencingToken = Number(fenceRaw);
	if (!/^\d{1,9}$/.test(fenceRaw)) {
		problems.push(
			"HARBOR_FENCING_TOKEN is not a positive integer. Every privileged call from a sandbox "
				+ "carries one; without it the control plane cannot tell this box from one whose lease "
				+ "lapsed while it kept running, and it refuses rather than guessing. Booting without "
				+ "one would produce a box that comes up cleanly and is rejected by every call it makes.",
		);
	}

	const runtimeRaw = (env.HARBOR_AGENT_RUNTIME ?? "").trim();
	if (!isAgentRuntime(runtimeRaw)) {
		problems.push(
			`HARBOR_AGENT_RUNTIME=${JSON.stringify(runtimeRaw)} is not one of ${AGENT_RUNTIMES.join(", ")}. `
				+ "It is refused rather than defaulted: defaulting means a session configured for one "
				+ "agent silently runs another, and the first sign is a transcript in the wrong format.",
		);
	}

	let repos: RepoSpec[] = [];
	try {
		repos = parseRepos(env.HARBOR_REPOS ?? "[]");
	} catch (error) {
		problems.push(`HARBOR_REPOS: ${(error as Error).message}`);
	}

	if (problems.length > 0) return { kind: "invalid", problems };

	const config: SupervisorConfig = {
		controlUrl,
		sandboxId,
		sessionId,
		token,
		fencingToken,
		runtime: runtimeRaw as AgentRuntime,
		workspaceRoot: (env.HARBOR_WORKSPACE_ROOT ?? "/workspace").trim(),
		repos,
		requestedBootMode: env.HARBOR_BOOT_MODE ?? null,
	};
	if (env.HARBOR_TRACE_ID !== undefined && env.HARBOR_TRACE_ID !== "") {
		config.traceId = env.HARBOR_TRACE_ID;
	}
	return { kind: "ok", config };
}

function isAgentRuntime(value: string): value is AgentRuntime {
	return (AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function parseRepos(raw: string): RepoSpec[] {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("expected a JSON array of {name, url, ref?}.");
	return parsed.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`entry ${index} is not an object.`);
		const record = entry as Record<string, unknown>;
		if (typeof record.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(record.name)) {
			// The name becomes a path segment under the workspace root. A `..` or a `/`
			// here is a path traversal that writes a clone outside the workspace, which
			// on most images means somewhere the agent can then execute from.
			throw new Error(`entry ${index} has an unusable directory name; expected [A-Za-z0-9._-]+.`);
		}
		if (typeof record.url !== "string" || record.url === "") {
			throw new Error(`entry ${index} has no url.`);
		}
		const spec: RepoSpec = { name: record.name, url: record.url };
		if (typeof record.ref === "string" && record.ref !== "") spec.ref = record.ref;
		return spec;
	});
}

// ---------------------------------------------------------------------------
// Running a child process with a bound
// ---------------------------------------------------------------------------

export interface RunResult {
	code: number | null;
	timedOut: boolean;
	output: string;
}

/**
 * Run a command with a wall-clock ceiling, capturing a bounded tail of output.
 *
 * SIGTERM first, then SIGKILL after a grace period, because a `setup.sh` that
 * spawns a package manager needs a moment to let its children die; killing the
 * shell alone leaves a detached `npm` holding the workspace and the next step
 * fails on a lock file with no explanation of what is holding it.
 */
export function runCommand(
	bin: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onLine?: (line: string) => void },
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let timedOut = false;
		const cap = setting("maxRunOutputChars");

		const absorb = (chunk: Buffer): void => {
			const text = chunk.toString("utf8");
			output = (output + text).slice(-cap);
			if (options.onLine) for (const line of text.split("\n")) if (line !== "") options.onLine(line);
		};
		child.stdout?.on("data", absorb);
		child.stderr?.on("data", absorb);

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), Math.max(1, Math.floor(options.timeoutMs / 10))).unref?.();
		}, options.timeoutMs);

		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, timedOut, output: `${output}\n${error.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, timedOut, output });
		});
	});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export type BootOutcome =
	| { kind: "ready"; mode: BootMode; warnings: BootWarning[] }
	| { kind: "failed"; stage: string; message: string; warnings: BootWarning[] };

/**
 * The whole boot, as one readable sequence.
 *
 * Warnings are accumulated in a single array and flushed twice — to
 * `BOOT_WARNINGS_PATH` and to the bridge — rather than being logged where they
 * occur. Logging where they occur is what produces a system where the answer to
 * "why is the dev server not up" is in a file inside a container that has since
 * been destroyed.
 */
export async function boot(
	config: SupervisorConfig,
	bridge: Bridge,
	env: NodeJS.ProcessEnv = process.env,
): Promise<BootOutcome> {
	const warnings: BootWarning[] = [];
	const warn = (warning: BootWarning): void => {
		warnings.push(warning);
		bridge.emit({
			type: "log",
			payload: { level: "warning", code: warning.code, message: warning.message },
		});
	};

	bridge.emit({ type: "boot_started", payload: { requested_mode: config.requestedBootMode } });

	const primary = join(config.workspaceRoot, config.repos[0]?.name ?? "");
	const resolution = resolveBootMode({
		requested: config.requestedBootMode,
		snapshotsEnabled: setting("enableSnapshots"),
		workspacePopulated: hasCheckout(primary),
	});
	if (resolution.kind === "refused") {
		return finish({ kind: "failed", stage: "boot_mode", message: resolution.message, warnings });
	}
	if (resolution.warning !== null) warn(resolution.warning);

	const mode = resolution.mode;
	// One resolution, exported once. Repository hooks read the same answer this
	// process used, which is what stops a `start.sh` from re-deriving it from
	// something else and disagreeing.
	env.HARBOR_BOOT_MODE = mode;
	bridge.emit({ type: "boot_progress", payload: { stage: "boot_mode", mode, reason: resolution.reason } });

	await configureGit(config, env);

	if (mode === "fresh") {
		const cloned = await cloneRepos(config, bridge, env);
		if (cloned !== null) {
			return finish({ kind: "failed", stage: "clone", message: cloned, warnings });
		}
	}

	const setupResult = await runHook("setup", config, mode, bridge, env, primary);
	if (setupResult.kind === "failed") {
		return finish({ kind: "failed", stage: "setup", message: setupResult.message, warnings });
	}
	if (setupResult.kind === "degraded") warn(setupResult.warning);

	const tunnels = await waitForTunnels(config, bridge, env);
	if (tunnels !== null) warn(tunnels);

	const startResult = await runHook("start", config, mode, bridge, env, primary);
	if (startResult.kind === "failed") {
		return finish({ kind: "failed", stage: "start", message: startResult.message, warnings });
	}
	if (startResult.kind === "degraded") warn(startResult.warning);

	return finish({ kind: "ready", mode, warnings });

	function finish(outcome: BootOutcome): BootOutcome {
		writeWarningsFile(warnings, config);
		if (outcome.kind === "ready") {
			bridge.emit({
				type: "boot_ready",
				payload: { mode: outcome.mode, warnings: warnings.length, workspace: primary },
			});
		} else {
			bridge.emit({
				type: "boot_failed",
				payload: { stage: outcome.stage, message: outcome.message, warnings: warnings.length },
			});
		}
		return outcome;
	}
}

/** A directory that exists and is not empty. The cheapest honest test for "restored". */
function hasCheckout(path: string): boolean {
	try {
		return existsSync(path) && readdirSync(path).length > 0;
	} catch {
		// A workspace we cannot read is not a workspace we can claim is populated.
		// This is the fail-CLOSED direction on an authority-shaped question — "has
		// provisioning already happened here?" — and the asymmetry is deliberate: an
		// unknown *liveness* answer (see `DEAD_SANDBOX_STATUSES`) resolves as alive,
		// because abandoning a working box is unrecoverable, while an unknown
		// *provisioning* answer resolves as "not done", because re-running setup on a
		// box that did not need it costs minutes and skipping it on a box that did
		// costs the whole session.
		return false;
	}
}

/**
 * Write the warnings where a human on the box can find them, without failing over it.
 *
 * The file is the secondary channel. If the bridge is down and the directory is
 * read-only, having lost a warning file is not a reason to fail a boot that
 * otherwise succeeded — the timeline copy is the one that gets read.
 */
function writeWarningsFile(warnings: BootWarning[], config: SupervisorConfig): void {
	try {
		mkdirSync(join(config.workspaceRoot, ".harbor"), { recursive: true });
		writeFileSync(
			BOOT_WARNINGS_PATH,
			`${JSON.stringify({ sandbox_id: config.sandboxId, warnings }, null, 2)}\n`,
			"utf8",
		);
	} catch (error) {
		console.error(`[supervisor] boot.warnings_file_unwritable ${(error as Error).message}`);
	}
}

/**
 * Point git at the in-sandbox credential helper.
 *
 * `--global`, not per-repository, because `.harbor/setup.sh` legitimately clones
 * *other* private repositories the installation can reach — a shared component
 * library, a private package registry backed by a repo — and those clones happen
 * before any repository-local config exists. The helper itself is what bounds the
 * blast radius: it authorises exactly one SCM host over HTTPS and declines
 * everything else, so a global helper is not a global credential.
 */
async function configureGit(config: SupervisorConfig, env: NodeJS.ProcessEnv): Promise<void> {
	const set = (key: string, value: string): Promise<void> =>
		new Promise((resolve) => {
			execFile("git", ["config", "--global", key, value], { env }, () => resolve());
		});
	await set("credential.helper", "harbor");
	// Without this git omits `path` from the credential request, and the broker then
	// has no repository to scope the token to — which forces either a refusal or an
	// installation-wide credential handed to an unattended boot clone.
	await set("credential.useHttpPath", "true");
	// Without this a helper that declines leaves git waiting on a terminal that
	// does not exist, and the turn hangs until the turn timeout rather than
	// failing in milliseconds with a message naming the host.
	await set("core.askPass", "");
	await set("safe.directory", "*");
	await set("advice.detachedHead", "false");
	env.GIT_TERMINAL_PROMPT = "0";
	env.HARBOR_SANDBOX_ID = config.sandboxId;
	env.HARBOR_SESSION_ID = config.sessionId;

	// The one host the credential helper will authorise. Derived from the primary
	// repository's own URL when the control plane did not state it, because the
	// alternative — leaving it unset — makes the helper decline every request and
	// presents as "clone asked for a password", which sends whoever is debugging it
	// looking at GitHub App permissions rather than at one missing variable.
	if ((env.HARBOR_SCM_HOST ?? "") === "") {
		const primaryUrl = config.repos[0]?.url;
		if (primaryUrl !== undefined) {
			try {
				env.HARBOR_SCM_HOST = new URL(primaryUrl).host.toLowerCase();
			} catch {
				// A URL we cannot parse leaves the helper with no authorised host, which
				// is the fail-closed direction: no credential is issued to anyone.
			}
		}
	}
}

/**
 * Clone every repository side by side under the workspace root.
 *
 * Side by side rather than nested, because a session spanning a service and its
 * client is the ordinary case for the work people actually give a background
 * agent, and nesting one inside the other makes the inner one a submodule-shaped
 * problem the moment anyone commits.
 *
 * `--filter=blob:none` rather than `--depth 1`: a partial clone keeps the full
 * commit graph, so `git log`, `git blame` and branching off an older commit all
 * work, while blobs are fetched on demand. A shallow clone saves the same time and
 * then breaks the first time an agent needs history, which it needs precisely when
 * the task is "why did this change".
 */
async function cloneRepos(
	config: SupervisorConfig,
	bridge: Bridge,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	await mkdir(config.workspaceRoot, { recursive: true });
	for (const repo of config.repos) {
		const target = join(config.workspaceRoot, repo.name);
		bridge.emit({ type: "boot_progress", payload: { stage: "clone", repo: repo.name } });

		const args = ["clone", "--filter=blob:none", repo.url, target];
		if (repo.ref !== undefined) args.splice(2, 0, "--branch", repo.ref);
		const result = await runCommand("git", args, {
			cwd: config.workspaceRoot,
			// git's credential protocol carries no operation, so the privilege the
			// broker should mint is stated here instead of inferred. A boot clone is
			// read-only; an agent turn (below) is the only thing that gets write.
			env: { ...env, HARBOR_GIT_OPERATION: "clone" },
			timeoutMs: setting("sandboxBootTimeoutMs"),
		});
		if (result.code !== 0) {
			return (
				`Cloning ${repo.name} ${result.timedOut ? "timed out" : `failed (exit ${result.code})`}. `
				+ `git said: ${tail(result.output)}`
			);
		}
	}
	return null;
}

type HookResult =
	| { kind: "ok" }
	| { kind: "skipped" }
	| { kind: "degraded"; warning: BootWarning }
	| { kind: "failed"; message: string };

/**
 * Run a repository hook under the policy for this boot mode.
 *
 * The fatality asymmetry is decided in `hookPolicy` and merely obeyed here; the
 * reasoning lives next to the decision. What this function adds is that a
 * non-fatal failure still produces a `BootWarning` — a swallowed failure and a
 * reported-but-tolerated failure look identical to the box and completely
 * different to the person whose dependencies did not install.
 */
async function runHook(
	hook: HookName,
	config: SupervisorConfig,
	mode: BootMode,
	bridge: Bridge,
	env: NodeJS.ProcessEnv,
	workspace: string,
): Promise<HookResult> {
	const policy = hookPolicy(hook, mode);
	if (!policy.run) {
		bridge.emit({
			type: "boot_progress",
			payload: { stage: `${hook}.skipped`, reason: policy.skipReason, mode },
		});
		return { kind: "skipped" };
	}

	const script = join(workspace, ".harbor", `${hook}.sh`);
	if (!existsSync(script)) return { kind: "skipped" };

	bridge.emit({ type: "boot_progress", payload: { stage: hook, script } });
	const result = await runCommand("bash", [script], {
		cwd: workspace,
		env: { ...env, HARBOR_BOOT_MODE: mode },
		timeoutMs: setting(policy.timeoutSetting),
		onLine: (line) => bridge.emit({ type: "log", payload: { source: hook, line: stripAnsi(line) } }),
	});
	if (result.code === 0) return { kind: "ok" };

	const what = result.timedOut
		? `timed out after ${setting(policy.timeoutSetting)}ms`
		: `exited ${result.code}`;

	switch (policy.fatality) {
		case "fatal":
			return {
				kind: "failed",
				message:
					`.harbor/${hook}.sh ${what}. The boot failed rather than continuing: this hook `
					+ "starts the services the agent is told exist, and an agent working against "
					+ `services that are not there produces confidently wrong work. Output: ${tail(result.output)}`,
			};
		case "non_fatal":
			return {
				kind: "degraded",
				warning: {
					code: `hook.${hook}_failed`,
					message:
						`.harbor/${hook}.sh ${what}. The sandbox is up and usable — the repository is `
						+ "checked out and git works — but dependencies may be missing, so expect the "
						+ `agent's first build or test run to fail. Output: ${tail(result.output)}`,
				},
			};
	}
	return assertNever(policy.fatality, "hook fatality in runHook");
}

/**
 * Wait for the control plane to publish port forwards, bounded, then carry on.
 *
 * Returns a warning when it gave up, `null` when it did not need to. The decision
 * about *when* to give up — and the `>=` that makes a zero wait mean zero — is in
 * `tunnelWaitVerdict`; this loop only polls.
 */
async function waitForTunnels(
	config: SupervisorConfig,
	bridge: Bridge,
	env: NodeJS.ProcessEnv,
): Promise<BootWarning | null> {
	const waitMs = setting("tunnelWaitMs");
	const started = Date.now();

	const initial = tunnelFileDecision({ contents: readIfExists(TUNNEL_ENV_PATH), sandboxId: config.sandboxId });
	if (initial.action === "clear_and_wait") {
		// Delete before anything can read it. An inherited file points at another
		// box's port forward, and a service bound to a hostname that resolves
		// somewhere else is far harder to diagnose than one with no hostname at all.
		await rm(TUNNEL_ENV_PATH, { force: true });
		bridge.emit({
			type: "log",
			payload: { level: "info", code: "tunnel.env_file_cleared", reason: initial.reason },
		});
	}

	for (;;) {
		const verdict = tunnelWaitVerdict({
			contents: readIfExists(TUNNEL_ENV_PATH),
			sandboxId: config.sandboxId,
			elapsedMs: Date.now() - started,
			waitMs,
		});
		if (verdict.kind === "ready") {
			for (const [key, value] of Object.entries(verdict.vars)) env[key] = value;
			bridge.emit({
				type: "boot_progress",
				payload: { stage: "tunnels", variables: Object.keys(verdict.vars).length },
			});
			return null;
		}
		if (verdict.kind === "proceed_without_tunnels") {
			console.warn(`[supervisor] ${verdict.logCode}`);
			return verdict.warning;
		}
		// Poll rather than watch: inotify inside a container on an overlay filesystem
		// misses writes from a bind-mounted host process often enough that a watcher
		// here would be a source of exactly the hang this timeout exists to bound.
		await sleep(Math.min(verdict.remainingMs, Math.max(1, Math.floor(waitMs / 30))));
	}
}

function readIfExists(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function tail(output: string): string {
	const cap = setting("maxEventPayloadChars");
	return output.length > cap ? `…${output.slice(-cap)}` : output;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * Drive one turn through the adapter, translating its stdout into session events.
 *
 * The adapter owns the argv, the parsing and the interrupt signal; this owns the
 * process, the timeout and the accounting. Keeping the accounting here — rather
 * than in each adapter — is what makes `usageAccumulationFor` the single place
 * that answers "is this usage record a running total or an increment", a question
 * whose wrong answer is an invoice nobody notices for a month.
 */
export function createTurnRunner(
	adapter: AgentAdapter,
	config: SupervisorConfig,
	bridge: Bridge,
	env: NodeJS.ProcessEnv,
): { run: (invocation: TurnInvocation) => Promise<void>; interrupt: (kind: AgentInterrupt) => void } {
	let active: ReturnType<typeof spawn> | null = null;
	const workspace = join(config.workspaceRoot, config.repos[0]?.name ?? "");
	let resumeToken: string | null = null;

	return {
		interrupt(kind) {
			// No-op when nothing is running rather than an error: a `stop` that arrives
			// microseconds after the turn ended is a race, not a fault, and turning it
			// into an error trains people to ignore errors.
			active?.kill(adapter.interrupt(kind));
		},

		async run(invocation) {
			const request: AgentTurnRequest = {
				prompt_id: invocation.promptId,
				session_id: config.sessionId,
				seq: invocation.seq,
				body: invocation.body,
				identity: invocation.identity,
				resume_token: resumeToken,
				workspace,
				timeout_ms: invocation.timeoutMs,
			};
			const plan = adapter.command(request);
			const child = spawn(plan.bin, plan.args, {
				cwd: workspace,
				// `push` is stated, not guessed. A turn is the one context in which
				// writing to the repository is legitimate, and every other process in the
				// box falls back to the helper's read-only default.
				env: { ...env, HARBOR_GIT_OPERATION: "push", ...plan.env },
				stdio: ["ignore", "pipe", "pipe"],
			});
			active = child;

			const accumulation = usageAccumulationFor(adapter.runtime);
			let usage: AgentUsage | null = null;
			let stdout = "";
			let timedOut = false;

			const timer = setTimeout(() => {
				timedOut = true;
				child.kill(adapter.interrupt("cancel"));
			}, invocation.timeoutMs);

			const lines = createInterface({ input: child.stdout! });
			lines.on("line", (raw) => {
				stdout += `${raw}\n`;
				for (const event of adapter.parseLine(raw)) {
					switch (event.kind) {
						case "message":
							bridge.emit({ type: "agent_message", payload: { text: event.text, prompt_id: invocation.promptId } });
							break;
						case "tool_call":
							bridge.emit({
								type: "agent_tool_call",
								payload: { tool: event.tool, phase: event.phase, summary: event.summary, prompt_id: invocation.promptId },
							});
							break;
						case "usage":
							usage = accumulation === "absolute" ? event.usage : addUsage(usage, event.usage);
							break;
						case "warning":
							bridge.emit({ type: "log", payload: { level: "warning", source: adapter.runtime, message: event.message } });
							break;
					}
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				bridge.emit({ type: "log", payload: { level: "info", source: adapter.runtime, line: stripAnsi(chunk.toString("utf8")) } });
			});

			const code = await new Promise<number | null>((resolve) => {
				child.on("error", () => resolve(null));
				child.on("close", (exitCode) => resolve(exitCode));
			});
			clearTimeout(timer);
			lines.close();
			active = null;

			resumeToken = adapter.resumeTokenFrom(stdout, workspace) ?? resumeToken;
			bridge.emit({
				type: timedOut || code !== 0 ? "agent_failed" : "agent_finished",
				payload: {
					prompt_id: invocation.promptId,
					exit_code: code,
					timed_out: timedOut,
					usage: usage ?? { source: "unavailable", input_tokens: 0, output_tokens: 0, model: null },
					resume_token: resumeToken,
				},
			});
		},
	};
}

function addUsage(current: AgentUsage | null, next: AgentUsage): AgentUsage {
	if (current === null) return next;
	return {
		source: next.source,
		input_tokens: current.input_tokens + next.input_tokens,
		output_tokens: current.output_tokens + next.output_tokens,
		model: next.model ?? current.model,
		...(current.micro_usd !== undefined || next.micro_usd !== undefined
			? { micro_usd: (current.micro_usd ?? 0) + (next.micro_usd ?? 0) }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	validateConfig();

	const resolution = readSupervisorConfig(env);
	if (resolution.kind === "invalid") {
		for (const problem of resolution.problems) console.error(`[supervisor] config: ${problem}`);
		return 78; // EX_CONFIG. A distinct code so a supervisor that never started is
		// distinguishable from one whose boot failed, which the provider reports as
		// the same "container exited" without it.
	}
	const config = resolution.config;

	const lookup = adapterFor(config.runtime);
	if (!lookup.ok) {
		console.error(`[supervisor] adapter: ${lookup.message}`);
		return 78;
	}

	let runner: { interrupt: (kind: AgentInterrupt) => void } | null = null;
	const handlers: BridgeHandlers = {
		runTurn: async (invocation) => {
			await turnRunner.run(invocation);
		},
		interrupt: (kind) => runner?.interrupt(kind),
		quiesceForSnapshot: async () => {},
		shutdown: (reason) => {
			void shutdown(reason);
		},
	};

	const bridge = new Bridge(
		{
			controlUrl: config.controlUrl,
			sandboxId: config.sandboxId,
			sessionId: config.sessionId,
			token: config.token,
			fencingToken: config.fencingToken,
			workspace: join(config.workspaceRoot, config.repos[0]?.name ?? ""),
			...(config.traceId !== undefined ? { traceId: config.traceId } : {}),
		},
		handlers,
		defaultBridgeDeps(),
	);

	const turnRunner = createTurnRunner(lookup.adapter, config, bridge, env);
	runner = turnRunner;

	let exiting = false;
	const shutdown = async (reason: string): Promise<void> => {
		if (exiting) return;
		exiting = true;
		bridge.emit({ type: "log", payload: { level: "info", code: "supervisor.shutdown", reason } });
		// Drain within one heartbeat interval. The events sitting in the buffer at
		// this moment are the ones that explain why the session ended, and losing
		// them means the timeline stops mid-sentence; taking longer than a heartbeat
		// makes an orderly shutdown look like a dead box to the liveness check.
		await bridge.stop(setting("sandboxHeartbeatIntervalMs"));
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	const serving = bridge.start();
	const outcome = await boot(config, bridge, env);
	if (outcome.kind === "failed") {
		await bridge.stop(setting("sandboxHeartbeatIntervalMs"));
		return 1;
	}
	await serving;
	return 0;
}

// Only when executed, never when imported by a test.
if (process.argv[1] !== undefined && process.argv[1].endsWith("supervisor.js")) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error("[supervisor] unhandled:", error);
			process.exit(1);
		},
	);
}
