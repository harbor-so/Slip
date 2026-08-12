/**
 * Every tunable in Harbor, in one file, resolved at call time.
 *
 * The rule this file exists to enforce: **no timeout, threshold or limit is a
 * module-level constant anywhere else in the codebase.** `scripts/lint-config.mjs`
 * fails the build on one, and there is a test asserting that lint rule's error
 * message so the rule itself cannot rot into a no-op.
 *
 * The reason is a specific, predictable adopter experience. A self-hoster whose
 * monorepo legitimately takes four minutes to boot hits a ninety-second default
 * on their first day. If that number is `const BOOT_TIMEOUT_MS = 90_000` halfway
 * down a lifecycle file, their options are to fork the project or to give up, and
 * most people give up. Every number here is therefore an environment variable
 * with a documented default, and additionally overridable per repository — because
 * one slow repo should not force the whole deployment to wait four minutes for
 * every other one.
 *
 * Resolution order, most specific wins:
 *
 *     repos.config[key]  →  process.env[HARBOR_*]  →  the default below
 *
 * Two further disciplines:
 *
 *  - **Every default has its derivation written down.** "Stale heartbeat is three
 *    times the heartbeat interval" is a fact somebody can check and adjust
 *    coherently. "30000" is a number nobody will ever dare touch.
 *  - **Relationships are validated at startup** by `validateConfig()`, which fails
 *    fast on an incoherent combination. A stale-heartbeat threshold shorter than
 *    the heartbeat interval means every healthy sandbox is killed as unhealthy —
 *    an outage that presents as "the product does not work" with nothing in the
 *    logs pointing at configuration.
 */

/**
 * One tunable, with everything needed to resolve, document and validate it.
 *
 * `derivation` is not a comment. It is displayed by `GET /api/health/config`, so
 * an operator reading their live configuration sees why 90 seconds was chosen
 * rather than having to find this file.
 */
interface Setting<T> {
	env: string;
	fallback: T;
	derivation: string;
	parse: (raw: string) => T;
}

const asInt = (raw: string): number => {
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new ConfigError(`expected an integer, got ${JSON.stringify(raw)}`);
	}
	return value;
};

const asBool = (raw: string): boolean => raw === "1" || raw.toLowerCase() === "true";

const asString = (raw: string): string => raw;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * The registry. Adding a tunable means adding it here — which is the point,
 * because it then appears in the health endpoint and in the generated docs
 * without anybody remembering to write them.
 */
export const SETTINGS = {
	// -- Sandbox lifecycle ---------------------------------------------------

	sandboxBootTimeoutMs: {
		env: "HARBOR_SANDBOX_BOOT_TIMEOUT_MS",
		fallback: 180_000,
		derivation:
			"A fresh boot is clone + setup.sh + start.sh. Cloning a large monorepo and "
			+ "installing dependencies is 30-90s on a warm provider and several minutes "
			+ "on a cold one, so the default covers the slow case rather than the median. "
			+ "Too tight is worse than too loose here: a boot killed at 90s that would "
			+ "have succeeded at 100s looks to the user like the platform is broken, "
			+ "while an extra minute of waiting looks like a slow repo.",
		parse: asInt,
	} satisfies Setting<number>,

	sandboxHeartbeatIntervalMs: {
		env: "HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS",
		fallback: 15_000,
		derivation:
			"How often the bridge says it is alive. Frequent enough that a dead box is "
			+ "noticed within a minute, infrequent enough that a thousand sandboxes "
			+ "produce ~66 writes/second rather than a write storm.",
		parse: asInt,
	} satisfies Setting<number>,

	sandboxStaleHeartbeatMs: {
		env: "HARBOR_SANDBOX_STALE_HEARTBEAT_MS",
		fallback: 45_000,
		derivation:
			"Three times the heartbeat interval. Two would declare a box dead on a "
			+ "single dropped packet plus one slow tick, which on a busy provider "
			+ "happens daily; three tolerates one loss and one delay. Validated at "
			+ "startup to be strictly greater than the interval, because a value below "
			+ "it kills every healthy sandbox and presents as 'nothing works'.",
		parse: asInt,
	} satisfies Setting<number>,

	sandboxInactivityTimeoutMs: {
		env: "HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS",
		fallback: 900_000,
		derivation:
			"Fifteen minutes of no prompts and no agent activity before the box is "
			+ "snapshotted and stopped. Long enough that a human reading a diff and "
			+ "typing a follow-up does not pay a cold start; short enough that an "
			+ "abandoned session does not bill for an hour. This is the single largest "
			+ "lever on cost in the whole system.",
		parse: asInt,
	} satisfies Setting<number>,

	agentTurnTimeoutMs: {
		env: "HARBOR_AGENT_TURN_TIMEOUT_MS",
		fallback: 1_800_000,
		derivation:
			"Thirty minutes for one prompt. Matches the default claim lease so a turn "
			+ "cannot outlive the lease that authorises it — if these disagree, an agent "
			+ "keeps working after its lease lapsed and another agent legitimately takes "
			+ "the same task. Validated at startup against the lease default.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Circuit breaker -----------------------------------------------------

	circuitFailureThreshold: {
		env: "HARBOR_CIRCUIT_FAILURE_THRESHOLD",
		fallback: 3,
		derivation:
			"Three consecutive tripping failures opens the circuit. One is noise, two "
			+ "is a coincidence often enough to matter, three inside the window is a "
			+ "dependency that is down.",
		parse: asInt,
	} satisfies Setting<number>,

	circuitWindowMs: {
		env: "HARBOR_CIRCUIT_WINDOW_MS",
		fallback: 300_000,
		derivation:
			"Failures older than five minutes stop counting. Without a window the "
			+ "counter is cumulative and the circuit eventually opens on a service that "
			+ "has been healthy for a week.",
		parse: asInt,
	} satisfies Setting<number>,

	circuitCooldownMs: {
		env: "HARBOR_CIRCUIT_COOLDOWN_MS",
		fallback: 60_000,
		derivation:
			"How long the circuit stays open before one probe is allowed through. A "
			+ "minute is long enough for a provider restart, short enough that a "
			+ "recovered provider is discovered before a human notices.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Queue ---------------------------------------------------------------

	maxQueueDepth: {
		env: "HARBOR_MAX_QUEUE_DEPTH",
		fallback: 50,
		derivation:
			"Prompts waiting on one session. A cap exists because automations and child "
			+ "sessions both enqueue programmatically, which is a genuine amplification "
			+ "path — a misconfigured hourly automation with a retry loop can enqueue "
			+ "without bound, and the failure presents as a session that will not stop "
			+ "working days after anyone asked it to.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Event stream --------------------------------------------------------

	maxSnapshotEvents: {
		env: "HARBOR_MAX_SNAPSHOT_EVENTS",
		fallback: 500,
		derivation:
			"Events in one snapshot before it is truncated and the client pages for "
			+ "the rest. A snapshot is sent on every connect and reconnect, so on a "
			+ "flaky mobile connection it is the most-repeated payload in the system; "
			+ "uncapped, its size grows with the age of the session forever.",
		parse: asInt,
	} satisfies Setting<number>,

	eventRetentionCount: {
		env: "HARBOR_EVENT_RETENTION_COUNT",
		fallback: 5_000,
		derivation:
			"Events kept at full fidelity per session. Beyond this, token-level events "
			+ "are compacted into summarised turns and the originals deleted. A session "
			+ "streaming for two days otherwise grows without bound, and the bound is "
			+ "not theoretical: it is the same rows every snapshot has to read past.",
		parse: asInt,
	} satisfies Setting<number>,

	maxEventPayloadChars: {
		env: "HARBOR_MAX_EVENT_PAYLOAD_CHARS",
		fallback: 8_000,
		derivation:
			"A tool call's captured output is truncated to this before it is stored. "
			+ "The timeline is a timeline; a build log belongs in the run output, and "
			+ "the difference is what stops this table becoming a log pipeline the "
			+ "schema never signed up to be.",
		parse: asInt,
	} satisfies Setting<number>,

	maxActivityPayloadChars: {
		env: "HARBOR_MAX_ACTIVITY_PAYLOAD_CHARS",
		fallback: 16_000,
		derivation:
			"The backstop on one activity row's payload. Normalizers already clip "
			+ "individual strings; this catches a payload that is wide rather than deep — "
			+ "many small fields — which no per-field cap sees. Higher than the timeline's "
			+ "cap because activity carries structured tool arguments rather than prose.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Chat ----------------------------------------------------------------

	chatMaxContentChars: {
		env: "HARBOR_CHAT_MAX_CONTENT_CHARS",
		fallback: 8_000,
		derivation:
			"The longest a single chat message body may be before ingest refuses it. "
			+ "Long enough for a pasted stack trace or a diff hunk, short enough that one "
			+ "signed message cannot push megabytes through the event log or overrun a "
			+ "NOTIFY. A self-hoster who wants terser or roomier rooms changes it here.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Bridge --------------------------------------------------------------

	bridgeBufferLimit: {
		env: "HARBOR_BRIDGE_BUFFER_LIMIT",
		fallback: 1_000,
		derivation:
			"Events the bridge holds while disconnected from the control plane. "
			+ "Unbounded buffering OOMs the sandbox during a long partition and takes "
			+ "the agent's work with it; silently dropping puts an invisible hole in "
			+ "the record. At the cap the oldest are dropped and a visible gap marker "
			+ "is emitted, so the hole is in the record rather than hidden from it.",
		parse: asInt,
	} satisfies Setting<number>,

	credentialCacheMs: {
		env: "HARBOR_CREDENTIAL_CACHE_MS",
		fallback: 5_000,
		derivation:
			"How long the in-sandbox git credential helper reuses a brokered "
			+ "credential. Deliberately seconds, not minutes: long enough that a `git "
			+ "push` making several authenticated calls does not make several round "
			+ "trips and does not fail on a brief control-plane blip, short enough that "
			+ "a revoked installation stops working almost immediately. That coupling "
			+ "is the trade and it is why this is not zero.",
		parse: asInt,
	} satisfies Setting<number>,

	tunnelWaitMs: {
		env: "HARBOR_TUNNEL_WAIT_MS",
		fallback: 30_000,
		derivation:
			"How long the supervisor waits for tunnel URLs before running start.sh "
			+ "anyway. On timeout it logs and proceeds — degradation here is local and "
			+ "recoverable, and failing a boot because a port forward was slow would "
			+ "trade a minor inconvenience for a total one.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Hooks ---------------------------------------------------------------

	setupTimeoutMs: {
		env: "HARBOR_SETUP_TIMEOUT_MS",
		fallback: 300_000,
		derivation:
			"`.harbor/setup.sh` — dependency installation, which for a large monorepo "
			+ "is minutes. Non-fatal on a fresh boot: a broken provisioning step still "
			+ "leaves a usable box, and the warning is surfaced rather than swallowed.",
		parse: asInt,
	} satisfies Setting<number>,

	startTimeoutMs: {
		env: "HARBOR_START_TIMEOUT_MS",
		fallback: 120_000,
		derivation:
			"`.harbor/start.sh` — starting services the agent needs. Strict: a failure "
			+ "fails the boot. The asymmetry with setup.sh is deliberate. A broken "
			+ "runtime step means the agent works in an environment that lies to it, "
			+ "and confidently wrong work is more expensive than no work.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Cost ----------------------------------------------------------------

	maxSpendPerDayMicroUsd: {
		env: "HARBOR_MAX_SPEND_PER_DAY_MICRO_USD",
		fallback: 50_000_000,
		derivation:
			"$50/day per organisation, in millionths of a dollar. A default rather than "
			+ "unlimited, because every amplification path in this system is a loop with "
			+ "no human in it. On breach Harbor stops admitting new claims and does not "
			+ "kill running work — killing mid-turn wastes everything already spent.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Triggers (inbound event automations) --------------------------------

	triggerMaxBodyBytes: {
		env: "HARBOR_TRIGGER_MAX_BODY_BYTES",
		fallback: 1_000_000,
		derivation:
			"The largest inbound trigger payload accepted before a 413. Matches the "
			+ "connector webhook cap, and for the same reason: the HMAC signature is "
			+ "computed over the whole body, so an unbounded body is an unauthenticated "
			+ "way to make the server hash megabytes before it can reject the request.",
		parse: asInt,
	} satisfies Setting<number>,

	triggerReplayWindowSeconds: {
		env: "HARBOR_TRIGGER_REPLAY_WINDOW_SECONDS",
		fallback: 60 * 5,
		derivation:
			"How far a signed delivery timestamp (Sentry's `sentry-hook-timestamp`) may "
			+ "deviate from now, in either direction, before it is treated as a replay. "
			+ "Mirrors the Slack connector's five-minute window: generous enough for clock "
			+ "skew between the sender and this deployment, tight enough that a captured "
			+ "delivery is not a sandbox-spawning primitive forever. `Math.abs`, so a "
			+ "future-stamped delivery is rejected too — a one-sided check is forgeable by "
			+ "whoever controls the timestamp being signed over.",
		parse: asInt,
	} satisfies Setting<number>,

	triggerMaxRunsPerMinutePerAutomation: {
		env: "HARBOR_TRIGGER_MAX_RUNS_PER_MINUTE_PER_AUTOMATION",
		fallback: 10,
		derivation:
			"The most sessions one event automation may start per minute. Cron is "
			+ "naturally bounded to once a minute; an inbound webhook or a chatty Sentry "
			+ "project is not, so a retry storm is a genuine amplification path with no "
			+ "human in it. Above this, deliveries are shed — recorded, not fired — the "
			+ "same class of protection maxQueueDepth gives the enqueue path, and a "
			+ "cheaper stop than waiting for the daily spend cap to catch a runaway.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Coordination --------------------------------------------------------

	presenceWindowMs: {
		env: "HARBOR_PRESENCE_WINDOW_MS",
		fallback: 90_000,
		derivation:
			"How long after its last call an agent still counts as present. Presence is "
			+ "a byproduct of the five coordination calls rather than a heartbeat, so the "
			+ "window has to be longer than the gap between an agent's calls — a minute "
			+ "and a half tolerates an agent that is thinking rather than calling.",
		parse: asInt,
	} satisfies Setting<number>,

	claimSweepIntervalMs: {
		env: "HARBOR_CLAIM_SWEEP_INTERVAL_MS",
		fallback: 60_000,
		derivation:
			"How often lapsed leases are swept back to open. A backstop, not the "
			+ "mechanism — claim() already expires a stale holder before it inserts, so "
			+ "correctness never depends on this running. What it buys is timeliness: a "
			+ "task whose agent died reads as open in the dashboard within a minute.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Runs ----------------------------------------------------------------

	runOutputFlushMs: {
		env: "HARBOR_RUN_OUTPUT_FLUSH_MS",
		fallback: 1_000,
		derivation:
			"Output is buffered and flushed on a timer rather than written per chunk. A "
			+ "build log arrives in hundreds of small writes and one UPDATE each would "
			+ "swamp the database and the notify channel with nothing new to say.",
		parse: asInt,
	} satisfies Setting<number>,

	maxRunOutputChars: {
		env: "HARBOR_MAX_RUN_OUTPUT_CHARS",
		fallback: 200_000,
		derivation:
			"Bounded so a chatty agent cannot fill the database with one row. Past this "
			+ "the output is truncated with a visible marker rather than silently dropped.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Providers -----------------------------------------------------------

	sandboxProvider: {
		env: "HARBOR_SANDBOX_PROVIDER",
		fallback: "docker",
		derivation:
			"`docker` by default, and that is the strategic choice of the project. It "
			+ "is what lets someone evaluate the whole product on a laptop or inside a "
			+ "VPC with no vendor relationship at all. Remote providers are an upgrade, "
			+ "never a prerequisite.",
		parse: asString,
	} satisfies Setting<string>,

	sandboxImage: {
		env: "HARBOR_SANDBOX_IMAGE",
		fallback: "harbor-sandbox:latest",
		derivation: "The image `docker` and `fly` boot. Built by `npm run sandbox:build`.",
		parse: asString,
	} satisfies Setting<string>,

	enableSnapshots: {
		env: "HARBOR_ENABLE_SNAPSHOTS",
		fallback: false,
		derivation:
			"Off by default. Snapshot restore is a latency optimisation with real "
			+ "sharp edges — snapshots expire, some provider APIs are experimental, and "
			+ "on at least one provider snapshotting can terminate the source box. "
			+ "Shipping `fresh` only and letting an operator opt in is the honest "
			+ "default; shipping restore on by default means the first strange bug a "
			+ "new adopter hits is in the least observable part of the system.",
		parse: asBool,
	} satisfies Setting<boolean>,
} as const;

export type SettingKey = keyof typeof SETTINGS;

/** Per-repository overrides, as stored in `repos.config`. */
export type RepoOverrides = Partial<Record<SettingKey, unknown>>;

/**
 * Resolve one setting. Called at the point of use, never hoisted to a constant.
 *
 * Reading `process.env` on every call rather than once at import is deliberate:
 * a module-level read is captured before a test can set the variable, which
 * quietly makes every timeout in the test suite the production default. That is
 * how acceptance criterion "no test relies on a hardcoded default" gets violated
 * without anyone writing a hardcoded default.
 */
export function setting<K extends SettingKey>(
	key: K,
	overrides?: RepoOverrides,
): (typeof SETTINGS)[K]["fallback"] {
	const spec = SETTINGS[key];

	const override = overrides?.[key];
	if (override !== undefined && override !== null) {
		try {
			return spec.parse(String(override)) as (typeof SETTINGS)[K]["fallback"];
		} catch (error) {
			throw new ConfigError(
				`Repository override for ${key}: ${(error as Error).message}. `
					+ `Fix it in the repository's settings, or remove it to use ${spec.env}.`,
			);
		}
	}

	const raw = process.env[spec.env];
	if (raw !== undefined && raw !== "") {
		try {
			return spec.parse(raw) as (typeof SETTINGS)[K]["fallback"];
		} catch (error) {
			throw new ConfigError(`${spec.env}: ${(error as Error).message}.`);
		}
	}

	return spec.fallback as (typeof SETTINGS)[K]["fallback"];
}

/**
 * Relationships between settings that must hold for the system to work at all.
 *
 * Called at startup so an incoherent combination fails immediately and by name,
 * rather than producing a deployment where sandboxes are killed seconds after
 * booting and nothing in the logs says why. Each check names both variables and
 * says what the observed symptom would be — because the person reading this
 * error is usually looking at the symptom, not at the config.
 */
export function validateConfig(overrides?: RepoOverrides): void {
	const problems: string[] = [];

	const heartbeat = setting("sandboxHeartbeatIntervalMs", overrides);
	const stale = setting("sandboxStaleHeartbeatMs", overrides);
	if (stale <= heartbeat) {
		problems.push(
			`HARBOR_SANDBOX_STALE_HEARTBEAT_MS (${stale}) must be greater than `
				+ `HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS (${heartbeat}). As configured, a sandbox is `
				+ "declared stale before it can possibly have sent its next heartbeat, so every "
				+ "healthy sandbox is killed. The symptom is sessions that die seconds after "
				+ "becoming ready. Two to three times the interval is the useful range.",
		);
	}
	if (stale < heartbeat * 2) {
		problems.push(
			`HARBOR_SANDBOX_STALE_HEARTBEAT_MS (${stale}) is less than twice `
				+ `HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS (${heartbeat}). A single dropped heartbeat `
				+ "then kills a healthy sandbox, which on any real network happens daily.",
		);
	}

	const boot = setting("sandboxBootTimeoutMs", overrides);
	const setup = setting("setupTimeoutMs", overrides);
	const start = setting("startTimeoutMs", overrides);
	if (boot < setup + start) {
		problems.push(
			`HARBOR_SANDBOX_BOOT_TIMEOUT_MS (${boot}) is less than HARBOR_SETUP_TIMEOUT_MS `
				+ `(${setup}) plus HARBOR_START_TIMEOUT_MS (${start}). A repository whose hooks both `
				+ "run to their own limits would be killed by the outer timeout while behaving "
				+ "exactly as configured, and the failure would be attributed to the hooks.",
		);
	}

	const inactivity = setting("sandboxInactivityTimeoutMs", overrides);
	const turn = setting("agentTurnTimeoutMs", overrides);
	if (inactivity <= turn) {
		problems.push(
			`HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS (${inactivity}) must exceed `
				+ `HARBOR_AGENT_TURN_TIMEOUT_MS (${turn}). Otherwise a long turn that is working `
				+ "correctly is reaped as idle, and the user sees their agent stop mid-task with "
				+ "no explanation.",
		);
	}

	const retention = setting("eventRetentionCount", overrides);
	const snapshotCap = setting("maxSnapshotEvents", overrides);
	if (retention < snapshotCap) {
		problems.push(
			`HARBOR_EVENT_RETENTION_COUNT (${retention}) is below HARBOR_MAX_SNAPSHOT_EVENTS `
				+ `(${snapshotCap}). Compaction would then delete events a snapshot is still `
				+ "expected to carry, so a reconnecting client would be sent a snapshot with "
				+ "holes in it and no marker saying so.",
		);
	}

	if (problems.length > 0) {
		throw new ConfigError(
			`Harbor configuration is incoherent:\n\n${problems.map((p) => `  • ${p}`).join("\n\n")}`,
		);
	}
}

/**
 * The whole resolved configuration, with provenance. Served by the health
 * endpoint so "what is this deployment actually running with" is one curl rather
 * than an archaeology exercise across a Helm chart and a Dockerfile.
 */
export function describeConfig(overrides?: RepoOverrides) {
	return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
		const spec = SETTINGS[key];
		const fromRepo = overrides?.[key] !== undefined && overrides?.[key] !== null;
		const fromEnv = !fromRepo && Boolean(process.env[spec.env]);
		return {
			key,
			env: spec.env,
			value: setting(key, overrides),
			source: fromRepo ? "repository" : fromEnv ? "environment" : "default",
			derivation: spec.derivation,
		};
	});
}
