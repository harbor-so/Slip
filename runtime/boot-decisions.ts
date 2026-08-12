/**
 * Every branch the in-sandbox runtime takes, as a function of its inputs alone.
 *
 * This module exists because of a specific, documented failure in the reference
 * implementation Harbor is a response to: its supervisor is 2,523 lines in one
 * class, and boot-mode branching happens at roughly fifteen scattered call sites.
 * Nobody can say what a `snapshot_restore` boot does without reading all fifteen,
 * and when one of them is wrong the symptom is "setup.sh ran twice" or "setup.sh
 * never ran", observed hours later as a mysteriously broken environment. It is the
 * least observable component in that system, and the reason is not that boot is
 * hard — it is that the decisions are interleaved with the effects.
 *
 * So the decisions live here and nothing in this file performs one. No `fs`, no
 * `child_process`, no `fetch`, no clock, no `process.env`, no `setting()` — every
 * input arrives as an argument, including the ones that came from configuration.
 * `supervisor.ts` and `bridge.ts` resolve settings, read files and spawn
 * processes; they ask this module what to do and then do exactly that.
 *
 * Two consequences worth the constraint:
 *
 *  - The test (`boot-decisions.test.ts`) has zero mocks and can assert the exact
 *    boundary value of every threshold, including the ones — like a tunnel wait
 *    that expires at precisely its limit — that are otherwise only reachable by
 *    sleeping in a test and hoping.
 *  - Adding a `BootMode` or a `SandboxStatus` is a compile error at every place
 *    that has to decide something about it, because every switch here ends without
 *    a `default` branch. A `default` is how a new mode silently inherits whatever
 *    the previous one did, which is exactly the "setup.sh ran twice" bug.
 */

import type { SettingKey } from "../src/config.js";
import type { BootMode } from "../src/contracts/index.js";

/**
 * Turn a missed union member into a compile error.
 *
 * Duplicated from `runtime/adapters/index.ts` rather than imported, and that is
 * deliberate: this module's whole value is that it depends on nothing, and a
 * one-line helper is a cheaper price than an import that later drags a transitive
 * dependency into the pure layer.
 */
export function assertNever(value: never, context: string): never {
	throw new Error(`Unreachable ${context}: ${JSON.stringify(value)}`);
}

/**
 * Something that went wrong during boot but did not stop it.
 *
 * A warning is a value rather than a log line because a sandbox's log is written
 * to a file nobody opens. Every warning produced here is written to the warnings
 * file *and* pushed over the bridge as a `log` event, so the person looking at the
 * session timeline — the only surface anyone actually reads — sees that the box
 * came up degraded before they spend twenty minutes wondering why the dev server
 * is not reachable.
 *
 * `code` is a stable, greppable token; `message` is prose for a human. Both,
 * because a code alone is unreadable and prose alone is unsearchable.
 */
export interface BootWarning {
	code: string;
	message: string;
}

// ---------------------------------------------------------------------------
// 1. Boot mode
// ---------------------------------------------------------------------------

export type BootModeReason =
	/** Nothing asked for a mode. A box with no instructions clones from scratch. */
	| "unspecified"
	/** The control plane asked for `fresh` and got it. */
	| "requested"
	/** Restore was asked for, snapshots are on, and the disk has the restored tree. */
	| "restored_workspace_present"
	/** Restore was asked for but the disk is empty — the snapshot was empty or expired. */
	| "restore_yielded_empty_workspace"
	/** Restore was asked for, this box has snapshots off, and there is nothing to lose. */
	| "snapshots_disabled_workspace_empty";

export type BootModeRefusal =
	/** A string that is not a `BootMode` at all. */
	| "unrecognised"
	/** A real mode this version of the runtime does not implement. */
	| "unsupported_in_this_version"
	/** Restore requested, snapshots off, and a populated workspace we must not clone over. */
	| "restore_gate_conflict";

export type BootModeResolution =
	| {
			kind: "resolved";
			mode: BootMode;
			reason: BootModeReason;
			/**
			 * Set when the resolved mode is not the one that was asked for. The
			 * supervisor turns this into a warning; a silent downgrade is how a
			 * snapshot feature appears to work for months while never once restoring.
			 */
			degradedFrom: BootMode | null;
			warning: BootWarning | null;
	  }
	| { kind: "refused"; reason: BootModeRefusal; requested: string; message: string };

export interface BootModeInput {
	/** `HARBOR_BOOT_MODE` as the control plane set it. Untrusted: it is a string. */
	requested: string | null | undefined;
	/** `setting("enableSnapshots")`, resolved by the caller. */
	snapshotsEnabled: boolean;
	/** Does the workspace root already contain a checkout? See `resolveBootMode`. */
	workspacePopulated: boolean;
}

/**
 * The modes this version of the in-sandbox runtime can honour.
 *
 * `build` and `repo_image` are in the contract because they are real strategies
 * and the control plane may grow them, but they are refused here rather than
 * quietly treated as `fresh`. The reason is the hook table below: in `repo_image`,
 * `setup.sh` must *not* run because it already ran at image build time, and
 * treating an unimplemented mode as `fresh` runs it again — reinstalling
 * dependencies over a warm image, which is both the slow path and, for a
 * `setup.sh` that is not idempotent, the broken one. Refusing names the problem;
 * guessing produces a boot that is merely strange.
 */
const SUPPORTED_BOOT_MODES: readonly BootMode[] = ["fresh", "snapshot_restore"];

/**
 * Decide how this box came up. Exactly one mode, resolved once, at one site.
 *
 * `workspacePopulated` is the input that makes the snapshot cases decidable, and
 * it is worth saying why it is asked rather than assumed. The supervisor does not
 * perform the restore — the provider did, before the container's entrypoint ran —
 * so "was a snapshot actually restored?" is a question about the filesystem, not
 * about the request. A snapshot can expire, be garbage-collected by the provider,
 * or restore into an empty tree, and in every one of those cases the box comes up
 * with `HARBOR_BOOT_MODE=snapshot_restore` and nothing on disk. Trusting the
 * request there means skipping `setup.sh` on a box that has never had it run, and
 * the agent then starts work in a tree with no dependencies installed and no
 * indication anything is wrong.
 *
 * The one case that refuses rather than degrades is restore-requested plus
 * snapshots-off plus a populated workspace. That combination means this runtime
 * has been told not to trust restored state and is nonetheless looking at some,
 * and both available actions are destructive: clone over a tree that may contain
 * a colleague's uncommitted work, or run in a state we were configured not to
 * trust. A boot failure with a message naming `HARBOR_ENABLE_SNAPSHOTS` is
 * recoverable in one environment-variable change; either alternative is not
 * recoverable at all.
 */
export function resolveBootMode(input: BootModeInput): BootModeResolution {
	const requested = (input.requested ?? "").trim();

	if (requested === "") {
		return {
			kind: "resolved",
			mode: "fresh",
			reason: "unspecified",
			degradedFrom: null,
			warning: null,
		};
	}

	if (!isBootMode(requested)) {
		return {
			kind: "refused",
			reason: "unrecognised",
			requested,
			message:
				`HARBOR_BOOT_MODE=${JSON.stringify(requested)} is not a boot mode Harbor knows. `
				+ "The runtime refuses rather than falling back to 'fresh', because the fallback "
				+ "decides whether .harbor/setup.sh runs, and getting that wrong installs "
				+ "dependencies twice or not at all with no error either way.",
		};
	}

	if (!SUPPORTED_BOOT_MODES.includes(requested)) {
		return {
			kind: "refused",
			reason: "unsupported_in_this_version",
			requested,
			message:
				`Boot mode '${requested}' is defined in the contract but not implemented by this `
				+ "runtime, which supports 'fresh' and 'snapshot_restore'. It is refused rather "
				+ "than approximated: each mode implies a different answer to 'has setup.sh "
				+ "already run', and approximating that answer is silent and expensive.",
		};
	}

	switch (requested) {
		case "fresh":
			return { kind: "resolved", mode: "fresh", reason: "requested", degradedFrom: null, warning: null };

		case "snapshot_restore": {
			if (input.snapshotsEnabled && input.workspacePopulated) {
				return {
					kind: "resolved",
					mode: "snapshot_restore",
					reason: "restored_workspace_present",
					degradedFrom: null,
					warning: null,
				};
			}
			if (input.snapshotsEnabled && !input.workspacePopulated) {
				return {
					kind: "resolved",
					mode: "fresh",
					reason: "restore_yielded_empty_workspace",
					degradedFrom: "snapshot_restore",
					warning: {
						code: "boot.snapshot_restore_empty",
						message:
							"A snapshot restore was requested but the workspace is empty, so the snapshot "
							+ "was expired, garbage-collected, or never contained a checkout. Booting fresh "
							+ "instead: this turn pays a cold start, and it is correct. Repeated occurrences "
							+ "mean the snapshot retention window is shorter than the session idle timeout.",
					},
				};
			}
			if (!input.workspacePopulated) {
				return {
					kind: "resolved",
					mode: "fresh",
					reason: "snapshots_disabled_workspace_empty",
					degradedFrom: "snapshot_restore",
					warning: {
						code: "boot.snapshots_disabled",
						message:
							"A snapshot restore was requested but HARBOR_ENABLE_SNAPSHOTS is off inside this "
							+ "sandbox. The workspace is empty so booting fresh is safe, but the control plane "
							+ "and the sandbox image disagree about configuration, which will produce a "
							+ "confusing failure the first time a snapshot does contain state.",
					},
				};
			}
			return {
				kind: "refused",
				reason: "restore_gate_conflict",
				requested,
				message:
					"A snapshot restore was requested, HARBOR_ENABLE_SNAPSHOTS is off inside this "
					+ "sandbox, and the workspace already contains a checkout. Both ways out are "
					+ "destructive — cloning over a tree that may hold uncommitted work, or running in "
					+ "state this runtime was configured not to trust — so the boot fails instead. Set "
					+ "HARBOR_ENABLE_SNAPSHOTS=1 in the sandbox environment, or stop the control plane "
					+ "from requesting restores.",
			};
		}

		case "build":
		case "repo_image":
			// Unreachable: filtered by SUPPORTED_BOOT_MODES above. Listed anyway so that
			// implementing one of them is a compile error here rather than a silent
			// fall-through to the refusal.
			return {
				kind: "refused",
				reason: "unsupported_in_this_version",
				requested,
				message: `Boot mode '${requested}' is not implemented by this runtime.`,
			};
	}
	return assertNever(requested, "BootMode in resolveBootMode");
}

function isBootMode(value: string): value is BootMode {
	return value === "build" || value === "fresh" || value === "repo_image" || value === "snapshot_restore";
}

// ---------------------------------------------------------------------------
// 2. Hook policy — and the fatality asymmetry
// ---------------------------------------------------------------------------

export type HookName = "setup" | "start";

/**
 * The two tunables a hook can be bounded by, as a narrowed subset of `SettingKey`.
 *
 * `Extract` rather than a plain string union so that renaming either setting in
 * `src/config.ts` is a compile error here, instead of a key that resolves to
 * `undefined` and a hook that runs with no timeout at all.
 */
export type HookTimeoutSetting = Extract<SettingKey, "setupTimeoutMs" | "startTimeoutMs">;

export type HookSkipReason =
	/** `repo_image`: setup ran at image build time and its output is baked in. */
	| "already_applied_in_image"
	/** `snapshot_restore`: setup's output is in the restored filesystem. */
	| "already_in_filesystem"
	/** `build`: there is no agent and no session yet, so there is nothing to start. */
	| "no_runtime_at_build_time";

export type HookPolicy =
	| { run: false; hook: HookName; mode: BootMode; skipReason: HookSkipReason }
	| {
			run: true;
			hook: HookName;
			mode: BootMode;
			/** What a non-zero exit does. See the asymmetry note below. */
			fatality: "fatal" | "non_fatal";
			/** Which tunable bounds it. A key, not a number — this module reads no config. */
			timeoutSetting: HookTimeoutSetting;
	  };

/**
 * Whether a repository hook runs, and what happens when it fails.
 *
 * ## The asymmetry, and why it is not an oversight
 *
 * `.harbor/setup.sh` failing on a fresh boot is **non-fatal**. `.harbor/start.sh`
 * failing is **fatal**. These are opposite policies for two scripts that look
 * almost identical, and the difference is what each one's failure does to the
 * agent's model of the world.
 *
 * `setup.sh` provisions: install dependencies, warm a cache, fetch fixtures. When
 * it fails, the box is still a box. The repository is checked out, git works, the
 * agent can read every file, and a competent agent asked to fix a bug can often do
 * it and will find out about the missing dependency the first time it runs the
 * tests — with a real error message naming the real problem. Killing the boot
 * instead converts "you have a degraded environment, here is the warning" into
 * "your session failed", and the second is strictly less useful.
 *
 * `start.sh` runs services the agent is told exist: the dev server it is meant to
 * screenshot, the database its tests connect to, the mock API its integration
 * suite calls. When it fails silently the environment **lies**. The agent runs the
 * test suite, sees connection refused, concludes the code is broken, and
 * confidently "fixes" working code — or worse, marks a task complete because the
 * failing check never ran. Confidently wrong work costs more than no work: it
 * costs the tokens, plus a human's review, plus the trust they had in the last ten
 * things the agent said. So a failed `start.sh` fails the boot loudly, at the one
 * moment when the cause is unambiguous.
 *
 * The rule generalises: **a broken provisioning step degrades; a broken runtime
 * step deceives.** Degradation is recoverable and warns. Deception is not, and
 * must stop the world.
 */
export function hookPolicy(hook: HookName, mode: BootMode): HookPolicy {
	switch (hook) {
		case "setup":
			switch (mode) {
				case "build":
					// At image build time a failed setup must fail the build. Baking a broken
					// image is the one case where being permissive is permanent: every box
					// started from that image inherits the breakage with no warning anywhere.
					return { run: true, hook, mode, fatality: "fatal", timeoutSetting: "setupTimeoutMs" };
				case "fresh":
					return { run: true, hook, mode, fatality: "non_fatal", timeoutSetting: "setupTimeoutMs" };
				case "repo_image":
					return { run: false, hook, mode, skipReason: "already_applied_in_image" };
				case "snapshot_restore":
					return { run: false, hook, mode, skipReason: "already_in_filesystem" };
			}
			return assertNever(mode, "BootMode in hookPolicy(setup)");

		case "start":
			switch (mode) {
				case "build":
					return { run: false, hook, mode, skipReason: "no_runtime_at_build_time" };
				case "fresh":
				case "repo_image":
				case "snapshot_restore":
					// Every boot that will host an agent starts services, including a restored
					// one: a snapshot captures a filesystem, never a running process tree.
					return { run: true, hook, mode, fatality: "fatal", timeoutSetting: "startTimeoutMs" };
			}
			return assertNever(mode, "BootMode in hookPolicy(start)");
	}
	return assertNever(hook, "HookName in hookPolicy");
}

// ---------------------------------------------------------------------------
// 3. The tunnel env file
// ---------------------------------------------------------------------------

/**
 * Where published port-forward URLs land, and why the format is boring on purpose.
 *
 * Plain dotenv — `KEY=value`, one per line, no quoting, no interpolation, no
 * sections — because the consumers are `node --env-file`, `bun --env-file` and
 * `docker compose --env-file`, all three of which read exactly this and none of
 * which read anything cleverer. A JSON file would need a parser in every
 * `start.sh` in every adopting repository, and the parser people write in bash is
 * `grep | cut`, which is a dotenv parser with bugs.
 */
export const TUNNEL_ENV_PATH = "/workspace/.tunnels.env";

/**
 * The line that makes the file self-identifying, and the reason it exists.
 *
 * Without it, a box restored from a snapshot comes up holding the *previous*
 * box's tunnel URLs — they were on disk when the snapshot was taken. `start.sh`
 * reads them, the dev server advertises a hostname that now points at somebody
 * else's container or at nothing, and every symptom appears in the browser rather
 * than in this process. With it, the staleness is a one-line string comparison
 * performed before anything reads the file.
 */
export const TUNNEL_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID";

export type TunnelFileAction =
	/** The file is ours and current. Use it, do not wait. */
	| { action: "keep"; reason: "id_matches"; vars: Record<string, string> }
	/** Inherited from a snapshot or from a previous boot. Delete it, then wait. */
	| { action: "clear_and_wait"; reason: "id_mismatch"; staleSandboxId: string }
	/** A file with no owner line. Cannot be proven ours; same treatment. */
	| { action: "clear_and_wait"; reason: "id_missing" }
	/** No file at all — the ordinary fresh-boot case. */
	| { action: "wait"; reason: "absent" };

/**
 * What to do with whatever is at `TUNNEL_ENV_PATH` when the supervisor starts.
 *
 * The `keep` case is the one that is easy to get wrong by being too clever. It is
 * tempting to always wait for a fresh write, on the grounds that a file present at
 * startup must be stale. It is not: the control plane publishes ports and writes
 * this file as part of spawning, and on a fast provider that write legitimately
 * lands before the container's entrypoint has finished starting Node. Waiting
 * anyway adds the full `tunnelWaitMs` to every fast boot and then times out,
 * turning the best case into the worst one.
 *
 * The mismatch case fails **closed** — the file is deleted before anything can
 * read it — and that is the correct direction here despite tunnels being a
 * liveness-shaped concern, because a wrong URL is worse than a missing one. A
 * missing URL makes `start.sh` fail fast and say so. A wrong URL makes a service
 * come up bound to a hostname that resolves somewhere else entirely, and the agent
 * spends its turn debugging a network it cannot see.
 */
export function tunnelFileDecision(input: {
	contents: string | null;
	sandboxId: string;
}): TunnelFileAction {
	if (input.contents === null) return { action: "wait", reason: "absent" };

	const vars = parseDotenv(input.contents);
	const owner = vars[TUNNEL_SANDBOX_ID_KEY];

	if (owner === undefined || owner === "") return { action: "clear_and_wait", reason: "id_missing" };
	if (owner !== input.sandboxId) {
		return { action: "clear_and_wait", reason: "id_mismatch", staleSandboxId: owner };
	}
	return { action: "keep", reason: "id_matches", vars };
}

export type TunnelWaitVerdict =
	| { kind: "ready"; vars: Record<string, string> }
	| { kind: "keep_waiting"; remainingMs: number }
	| {
			kind: "proceed_without_tunnels";
			logCode: "tunnel.env_file_wait_timeout";
			warning: BootWarning;
	  };

/**
 * Poll verdict: has a usable tunnel file appeared, and if not, is it time to stop
 * caring?
 *
 * **Timing out proceeds.** It does not fail the boot, and that is the whole point
 * of separating this from `start.sh`'s fatality. A port forward that has not
 * appeared in thirty seconds is usually one service the agent may never touch;
 * refusing to boot over it trades a local, recoverable, *possibly irrelevant*
 * problem for a total one. The failure is recorded three ways so it cannot be
 * mistaken for success — a log line with a stable code, a boot warning in the
 * warnings file, and a `log` event on the session timeline.
 *
 * The comparison is `>=`, deliberately: `tunnelWaitMs = 0` means "do not wait",
 * and with `>` it would mean "wait for exactly one poll interval", which is the
 * kind of off-by-one that only shows up in somebody's CI where the value was set
 * to zero to make tests fast.
 */
export function tunnelWaitVerdict(input: {
	contents: string | null;
	sandboxId: string;
	elapsedMs: number;
	waitMs: number;
}): TunnelWaitVerdict {
	const decision = tunnelFileDecision({ contents: input.contents, sandboxId: input.sandboxId });
	if (decision.action === "keep") return { kind: "ready", vars: decision.vars };

	if (input.elapsedMs >= input.waitMs) {
		return {
			kind: "proceed_without_tunnels",
			logCode: "tunnel.env_file_wait_timeout",
			warning: {
				code: "tunnel.env_file_wait_timeout",
				message:
					`No tunnel URLs were published within ${input.waitMs}ms, so this sandbox has no `
					+ `${TUNNEL_ENV_PATH} and any service in .harbor/start.sh that expects a public URL `
					+ "will fall back to localhost. The boot continued on purpose: a slow port forward "
					+ "is a local problem and failing the whole boot over it would be a total one.",
			},
		};
	}
	return { kind: "keep_waiting", remainingMs: input.waitMs - input.elapsedMs };
}

/**
 * The smallest dotenv reader that is correct for the files we write.
 *
 * Not a general one, and it says so: no interpolation, no `export ` prefix, no
 * multi-line values, no quote stripping. Every one of those is a feature some
 * dotenv library has and the three consumers named above disagree about, and a
 * parser that is more permissive than its writers is a parser that accepts a file
 * `docker compose` will reject. Unparseable lines are skipped rather than thrown
 * on, because this runs on the boot path and one malformed line should not be the
 * reason a session does not start.
 */
export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		out[key] = line.slice(eq + 1);
	}
	return out;
}

/**
 * Render the file. Refuses values that would corrupt it rather than escaping them.
 *
 * A newline inside a value is not a formatting inconvenience — in a format where
 * a line *is* a variable, it is a variable injection: a tunnel URL containing
 * `\nAWS_SECRET_ACCESS_KEY=…` would define that variable in every process started
 * with `--env-file`. Since no legitimate URL contains one, refusing is free and
 * escaping would be a quoting convention the three consumers do not share.
 */
export function formatDotenv(vars: Record<string, string>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(vars)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(
				`Tunnel variable name ${JSON.stringify(key)} is not a shell identifier and cannot be `
					+ "written to a dotenv file that `node --env-file` and `docker compose` both read.",
			);
		}
		if (/[\n\r\0]/.test(value)) {
			throw new Error(
				`Tunnel variable ${key} contains a newline or NUL. In a dotenv file a line is a `
					+ "variable, so this would define additional variables in every process started "
					+ "with --env-file. Refused rather than escaped.",
			);
		}
		lines.push(`${key}=${value}`);
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 4. Bounded buffering, and the hole that is in the record
// ---------------------------------------------------------------------------

/**
 * One slot in the bridge's disconnected buffer.
 *
 * The `gap` variant is the whole design. When the buffer is full the oldest
 * events are dropped — the alternative, unbounded growth, OOM-kills the sandbox
 * during a network partition and takes the agent's in-flight work with it, which
 * converts a transient connectivity problem into lost work. But dropping silently
 * puts an invisible hole in the transcript: a user reading the timeline later sees
 * a continuous sequence of events that is missing forty minutes, with nothing
 * saying so, and reasonably concludes the agent did nothing during that time.
 *
 * So the hole is **in** the record. A gap entry occupies the position where the
 * dropped events were, counts them, and is flushed to the control plane in order
 * with everything else.
 */
export type BufferEntry<E> =
	| { kind: "event"; event: E }
	| { kind: "gap"; droppedEvents: number; firstDroppedAt: string; lastDroppedAt: string };

export interface BufferPush<E> {
	buffer: Array<BufferEntry<E>>;
	/** How many events this push evicted. Zero on the ordinary path. */
	droppedNow: number;
	/** Whether a marker was created, an existing one was widened, or neither. */
	gap: "none" | "created" | "extended";
}

/**
 * Append an event, evicting the oldest if that would exceed the limit.
 *
 * ## Two invariants, and why each is load-bearing
 *
 * **The limit counts events, not entries.** A gap marker is O(1) metadata about
 * a hole, not a payload, and counting it against the cap means that at `limit = 1`
 * the buffer oscillates between holding one event and holding one marker,
 * retaining nothing. The cap exists to bound memory; one extra small object does
 * not threaten that.
 *
 * **There is at most one gap marker and it is always at index 0.** This falls out
 * of the structure rather than being enforced: events are appended at the tail and
 * evicted from the head, so the head is the only place a hole can form, and once a
 * marker is there every subsequent eviction widens it instead of creating a
 * second. That is what makes "one partition produces exactly one gap marker" a
 * property of the data structure rather than a thing the caller must remember —
 * and a caller that emits one marker per dropped event turns a thousand-event
 * partition into a thousand markers, which is a different way of making the
 * transcript unreadable.
 *
 * `limit <= 0` is honoured rather than rejected: it means "buffer nothing while
 * disconnected", every event becomes a widening of the gap marker, and the
 * transcript still records exactly how much was lost. An operator who sets it to
 * zero gets the behaviour they asked for and the accounting anyway.
 */
export function pushBounded<E>(
	buffer: ReadonlyArray<BufferEntry<E>>,
	event: E,
	limit: number,
	at: string,
): BufferPush<E> {
	const next = buffer.slice();
	const cap = Math.max(0, Math.floor(limit));

	if (cap === 0) {
		return { buffer: next, droppedNow: 1, gap: mergeGap(next, 1, at) };
	}

	next.push({ kind: "event", event });

	let droppedNow = 0;
	while (countEvents(next) > cap) {
		const index = next.findIndex((entry) => entry.kind === "event");
		// Unreachable while countEvents > cap >= 0, but a splice(-1) would silently
		// delete the newest entry instead of the oldest, so the guard stays.
		if (index < 0) break;
		next.splice(index, 1);
		droppedNow += 1;
	}

	if (droppedNow === 0) return { buffer: next, droppedNow: 0, gap: "none" };
	return { buffer: next, droppedNow, gap: mergeGap(next, droppedNow, at) };
}

function countEvents<E>(buffer: ReadonlyArray<BufferEntry<E>>): number {
	let count = 0;
	for (const entry of buffer) if (entry.kind === "event") count += 1;
	return count;
}

function mergeGap<E>(buffer: Array<BufferEntry<E>>, dropped: number, at: string): "created" | "extended" {
	const head = buffer[0];
	if (head !== undefined && head.kind === "gap") {
		head.droppedEvents += dropped;
		head.lastDroppedAt = at;
		return "extended";
	}
	buffer.unshift({ kind: "gap", droppedEvents: dropped, firstDroppedAt: at, lastDroppedAt: at });
	return "created";
}

// ---------------------------------------------------------------------------
// 5. Reconnect backoff
// ---------------------------------------------------------------------------

/**
 * How long to wait before the next reconnect attempt.
 *
 * Exponential, jittered, and **bounded** — the ceiling is the part that matters,
 * because an unbounded doubling reaches hours, and a sandbox that reconnects in
 * two hours has already been reaped as stale by the control plane and is burning
 * money doing nothing. So callers pass `ceilingMs` derived from the interval at
 * which they would be declared dead: never back off past the point where being
 * back is still worth anything.
 *
 * The jitter is half-range rather than full. Full jitter (`random * delay`)
 * produces near-zero delays often enough that a sandbox whose control plane is
 * hard-down spins on connect attempts; half-range keeps a floor at 50% of the
 * computed delay while still smearing a fleet's reconnects across the window,
 * which is what stops five hundred boxes retrying in lockstep after one deploy and
 * knocking the control plane over on its first breath.
 *
 * Pure: the caller supplies `random` (normally `Math.random()`), so the test can
 * assert both extremes exactly instead of sampling and hoping.
 */
export function reconnectDelayMs(input: {
	/** 1 for the first retry. Values below 1 are treated as 1. */
	attempt: number;
	baseMs: number;
	ceilingMs: number;
	/** In [0, 1). */
	random: number;
}): number {
	const attempt = Math.max(1, Math.floor(input.attempt));
	const base = Math.max(1, Math.floor(input.baseMs));
	const ceiling = Math.max(base, Math.floor(input.ceilingMs));

	// `2 ** attempt` overflows to Infinity somewhere past attempt 1024. `Math.min`
	// handles Infinity correctly, which is why the exponent is not clamped: the
	// result is the ceiling, which is the right answer for a long outage anyway.
	const window = Math.min(ceiling, base * 2 ** (attempt - 1));
	const random = Number.isFinite(input.random) ? Math.min(Math.max(input.random, 0), 1) : 0;
	return Math.max(1, Math.round(window / 2 + (window / 2) * random));
}
