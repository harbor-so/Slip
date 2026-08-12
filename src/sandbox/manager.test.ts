/**
 * Tests for the spawn saga, the fence, the shared breaker and the four watchdogs.
 *
 * Against real Postgres, and that is not a preference. Every property worth
 * asserting here is a property of how Postgres serialises, locks and makes rows
 * visible: two concurrent callers producing one container, a compare-and-set that
 * makes a sweep idempotent, an ordinal that survives two rows written in the same
 * millisecond. A mocked database passes all of them while the real one fails, which
 * is the worst possible outcome for a test suite guarding a spend guarantee.
 *
 * The provider is a fake written here, and it is fake for the opposite reason: what
 * these cases need is a backend that can be told to *lose its response*, which no
 * real one can be. `FakeProvider` records the box and then throws, which is exactly
 * failure (b) from the module header — the box exists, the caller has no idea — and
 * it is the case the whole reconciliation mechanism exists for.
 *
 * No `truncate` anywhere. Every assertion is scoped to an org created by the case
 * that made it, so this file does not own the database; a suite that truncates does
 * own it, and one that truncates while another file is mid-way through a session
 * produces a foreign key violation whose stack trace points nowhere near the cause.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RepoOverrides } from "../config.js";
import { db, sql } from "../db/index.js";
import { circuitBreakers, orgs, sandboxes, sessionEvents, sessionPrompts, sessions } from "../db/schema.js";
import { dequeuePrompt, createSession, queuePrompt } from "../lib/sessions.js";
import { readCircuit, recordProviderFailure, recordProviderSuccess } from "./circuit.js";
import {
	currentFencingToken,
	ensureSandbox,
	heartbeat,
	onConnectingTimeout,
	onExecutionTimeout,
	onInactivity,
	onStaleHeartbeat,
	stopSandbox,
	sweepDeadlines,
	validateFence,
} from "./manager.js";
import {
	type CreateSandboxConfig,
	type CreatedSandbox,
	type EphemeralProvider,
	type ProviderSandboxState,
	type SandboxInspection,
	type StopOutcome,
	SandboxProviderError,
} from "./provider.js";

// ---------------------------------------------------------------------------
// The fake provider
// ---------------------------------------------------------------------------

interface FakeBox {
	externalId: string;
	attemptId: string;
	state: ProviderSandboxState;
}

/**
 * A backend that can be told to fail in ways a real one cannot be asked to.
 *
 * `failCreate: "after_recording"` is the whole point of this class: the box is
 * created and registered — it exists, it would be billing — and then the call
 * throws. From the caller's side that is indistinguishable from a lost response,
 * and it is the only way to test that the retry adopts rather than duplicates.
 */
class FakeProvider implements EphemeralProvider {
	readonly kind = "ephemeral" as const;
	readonly name = "fake";
	readonly capabilities = {
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	boxes = new Map<string, FakeBox>();
	createCalls: string[] = [];
	stopCalls: string[] = [];
	findCalls: string[] = [];
	failCreate: "before_recording" | "after_recording" | null = null;
	failFind = false;
	private counter = 0;

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		this.createCalls.push(config.attemptId);
		if (this.failCreate === "before_recording") {
			throw new SandboxProviderError({
				message: "daemon refused the connection",
				errorType: "transient",
				provider: this.name,
				operation: "create",
			});
		}
		this.counter += 1;
		const externalId = `fake-${this.counter}`;
		this.boxes.set(externalId, { externalId, attemptId: config.attemptId, state: "running" });
		if (this.failCreate === "after_recording") {
			throw new SandboxProviderError({
				message: "socket hang up after the box was created",
				errorType: "transient",
				provider: this.name,
				operation: "create",
			});
		}
		return {
			externalId,
			provider: this.name,
			attemptId: config.attemptId,
			state: "running",
			createdAt: new Date().toISOString(),
		};
	}

	async stop(externalId: string): Promise<StopOutcome> {
		this.stopCalls.push(externalId);
		const box = this.boxes.get(externalId);
		if (!box) return "absent";
		if (box.state === "exited") return "already_stopped";
		box.state = "exited";
		return "stopped";
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const box = this.boxes.get(externalId);
		return box ? this.inspection(box) : null;
	}

	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		this.findCalls.push(attemptId);
		// Authority fails closed by contract: a backend that cannot answer throws
		// rather than reporting absence, because "I could not look" read as "there is
		// nothing there" is how one blip becomes two agents on one branch.
		if (this.failFind) {
			throw new SandboxProviderError({
				message: "backend unreachable",
				errorType: "transient",
				provider: this.name,
				operation: "find_by_attempt",
			});
		}
		for (const box of this.boxes.values()) {
			if (box.attemptId === attemptId) return this.inspection(box);
		}
		return null;
	}

	/** Boxes the backend still considers alive. The duplication assertion reads this. */
	liveBoxes(): FakeBox[] {
		return [...this.boxes.values()].filter((box) => box.state !== "exited");
	}

	private inspection(box: FakeBox): SandboxInspection {
		return {
			externalId: box.externalId,
			provider: this.name,
			state: box.state,
			rawState: box.state,
			attemptId: box.attemptId,
			sessionId: null,
			sandboxId: null,
			startedAt: null,
			exitCode: null,
		};
	}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgId: string;
let sessionId: string;
let provider: FakeProvider;

const NOW = new Date("2026-08-11T12:00:00.000Z");

beforeEach(async () => {
	const [org] = await db.insert(orgs).values({ name: "Sandbox Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Boot a box", createdBy: "@rin" });
	sessionId = session.id;
	provider = new FakeProvider();
});

afterAll(async () => {
	await sql.end();
});

async function sandboxRows() {
	return db
		.select()
		.from(sandboxes)
		.where(eq(sandboxes.sessionId, sessionId))
		.orderBy(sandboxes.createdAt);
}

/** Rows a spawn decision would consider live — the "at most one active" quantity. */
async function activeRows() {
	const rows = await sandboxRows();
	return rows.filter((row) => !["stopped", "stale", "failed"].includes(row.status));
}

async function eventsOfType(type: string) {
	return db
		.select()
		.from(sessionEvents)
		.where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.type, type)));
}

/** A sandbox row written directly, for the cases that need a specific history. */
async function insertSandbox(values: {
	status: string;
	createdAt: Date;
	externalId?: string | null;
	readyAt?: Date | null;
	lastHeartbeatAt?: Date | null;
	failureReason?: string | null;
}) {
	const [row] = await db
		.insert(sandboxes)
		.values({
			orgId,
			sessionId,
			provider: provider.name,
			status: values.status,
			createdAt: values.createdAt,
			externalId: values.externalId ?? null,
			readyAt: values.readyAt ?? null,
			lastHeartbeatAt: values.lastHeartbeatAt ?? null,
			failureReason: values.failureReason ?? null,
		})
		.returning();
	return row!;
}

// ---------------------------------------------------------------------------
// At most one active sandbox per lease
// ---------------------------------------------------------------------------

describe("ensureSandbox", () => {
	it("creates exactly one box when two callers race for one session", async () => {
		const [first, second] = await Promise.all([
			ensureSandbox({ orgId, sessionId, provider, now: NOW }),
			ensureSandbox({ orgId, sessionId, provider, now: NOW }),
		]);

		// One winner and one informative loser, never two containers. Which of the
		// two wins is not asserted, because it is genuinely a race and a test that
		// pins it is a test that fails on a slow day for no reason.
		const outcomes = [first.kind, second.kind].sort();
		expect(outcomes).toEqual(["created", "refused"]);
		const loser = first.kind === "refused" ? first : second.kind === "refused" ? second : null;
		expect(loser?.kind === "refused" ? loser.reason : null).toBe("already_active");

		expect(provider.createCalls).toHaveLength(1);
		expect(provider.liveBoxes()).toHaveLength(1);
		expect(await activeRows()).toHaveLength(1);
	});

	it("adopts the orphan left by a create whose response was lost", async () => {
		provider.failCreate = "after_recording";
		const lost = await ensureSandbox({ orgId, sessionId, provider, now: NOW });
		expect(lost.kind).toBe("failed");
		expect(provider.createCalls).toHaveLength(1);
		expect(provider.liveBoxes()).toHaveLength(1);

		provider.failCreate = null;
		const retry = await ensureSandbox({ orgId, sessionId, provider, now: NOW });

		expect(retry.kind).toBe("adopted");
		expect(retry.kind === "adopted" ? retry.reason : null).toBe("reconciled_orphan");
		expect(retry.kind === "adopted" ? retry.external_id : null)
			.toBe(provider.liveBoxes()[0]!.externalId);

		// The assertion that matters: the provider was asked to create once, and the
		// second call adopted rather than duplicated.
		expect(provider.createCalls).toHaveLength(1);
		expect(provider.findCalls).toHaveLength(1);
		expect(provider.liveBoxes()).toHaveLength(1);
		expect(await activeRows()).toHaveLength(1);
	});

	it("adopts a box left by a worker that crashed between intent and provider call", async () => {
		const overrides: RepoOverrides = { sandboxBootTimeoutMs: 60_000 };
		// The crash: an intent persisted, no failure recorded, nobody ever came back.
		const orphaned = await insertSandbox({
			status: "requested",
			createdAt: new Date(NOW.getTime() - 120_000),
		});
		// …and a box the dead worker did in fact create, discoverable only by its label.
		provider.boxes.set("fake-orphan", {
			externalId: "fake-orphan",
			attemptId: orphaned.id,
			state: "running",
		});

		const outcome = await ensureSandbox({
			orgId,
			sessionId,
			provider,
			now: NOW,
			repoOverrides: overrides,
		});

		expect(outcome.kind).toBe("adopted");
		expect(outcome.kind === "adopted" ? outcome.external_id : null).toBe("fake-orphan");
		expect(provider.createCalls).toHaveLength(0);
		expect(await activeRows()).toHaveLength(1);
	});

	it("creates one box, never two, when the crashed worker left nothing behind", async () => {
		const overrides: RepoOverrides = { sandboxBootTimeoutMs: 60_000 };
		const orphaned = await insertSandbox({
			status: "requested",
			createdAt: new Date(NOW.getTime() - 120_000),
		});

		const outcome = await ensureSandbox({
			orgId,
			sessionId,
			provider,
			now: NOW,
			repoOverrides: overrides,
		});

		expect(outcome.kind).toBe("created");
		expect(provider.findCalls).toEqual([orphaned.id]);
		expect(provider.createCalls).toHaveLength(1);
		expect(provider.liveBoxes()).toHaveLength(1);

		// The retired attempt is `failed` rather than deleted: it is the only record
		// that this session once had an attempt whose box could not be found.
		const rows = await sandboxRows();
		expect(rows).toHaveLength(2);
		expect(rows[0]!.status).toBe("failed");
		expect(await activeRows()).toHaveLength(1);
	});

	it("refuses rather than duplicating when the provider cannot answer a reconciliation", async () => {
		const orphaned = await insertSandbox({
			status: "requested",
			createdAt: new Date(NOW.getTime() - 120_000),
			failureReason: "provider_error",
		});
		provider.failFind = true;

		const outcome = await ensureSandbox({
			orgId,
			sessionId,
			provider,
			now: NOW,
			repoOverrides: { sandboxBootTimeoutMs: 60_000 },
		});

		// `findByAttemptId` throwing is the contract's fail-closed direction. A second
		// create here would be the exact bug the contract exists to prevent.
		expect(outcome.kind).toBe("failed");
		expect(provider.createCalls).toHaveLength(0);
		const rows = await sandboxRows();
		expect(rows.map((row) => row.id)).toEqual([orphaned.id]);
	});

	it("refuses without a timeline event when a live box already exists", async () => {
		await ensureSandbox({ orgId, sessionId, provider, now: NOW });
		const again = await ensureSandbox({ orgId, sessionId, provider, now: NOW });

		expect(again.kind === "refused" ? again.reason : null).toBe("already_active");
		// `already_active` is the normal result of two clients asking at once; a
		// `policy_denied` line for it would put an alarming red mark on the timeline
		// of a session where nothing went wrong.
		expect(await eventsOfType("policy_denied")).toHaveLength(0);
	});

	it("refuses a paused session with the reason a user can act on", async () => {
		await db
			.update(sessions)
			.set({ pausedReason: "budget_exhausted" })
			.where(eq(sessions.id, sessionId));

		const outcome = await ensureSandbox({ orgId, sessionId, provider, now: NOW });
		expect(outcome.kind === "refused" ? outcome.reason : null).toBe("budget_exhausted");
		expect(provider.createCalls).toHaveLength(0);
		expect(await eventsOfType("budget_exhausted")).toHaveLength(1);
	});

	it("refuses when the lease behind the spawn is not held", async () => {
		const outcome = await ensureSandbox({
			orgId,
			sessionId,
			provider,
			now: NOW,
			// A claim id that does not resolve is `not_held`, not `unknown`: the read
			// succeeded and the answer was "nobody holds this".
			claimId: "00000000-0000-0000-0000-000000000000",
		});
		expect(outcome.kind === "refused" ? outcome.reason : null).toBe("lease_not_held");
		expect(provider.createCalls).toHaveLength(0);
	});

	it("writes the intent, the attempt id and the fence before the provider is called", async () => {
		const outcome = await ensureSandbox({ orgId, sessionId, provider, now: NOW });
		expect(outcome.kind).toBe("created");

		const requested = await eventsOfType("sandbox_requested");
		expect(requested).toHaveLength(1);
		const payload = requested[0]!.payload as Record<string, unknown>;
		expect(payload.attempt_id).toBe(outcome.kind === "created" ? outcome.sandbox_id : null);
		expect(payload.fencing_token).toBe(1);
		// The attempt id the provider was handed is the row's primary key, which is
		// what makes an orphan discoverable at all.
		expect(provider.createCalls).toEqual([payload.attempt_id]);
	});
});

// ---------------------------------------------------------------------------
// Fencing
// ---------------------------------------------------------------------------

describe("validateFence", () => {
	it("refuses a running box whose token has been superseded", async () => {
		const first = await insertSandbox({ status: "ready", createdAt: new Date(NOW.getTime() - 5_000) });
		const second = await insertSandbox({ status: "ready", createdAt: NOW });

		expect(await currentFencingToken(sessionId)).toBe(2);

		// The point of the mechanism: the first box is READY, healthy, and convinced
		// it holds the work. It is refused anyway, because a newer box holds the fence.
		const stale = await validateFence(first.id, 1);
		expect(stale.valid).toBe(false);
		expect(stale.valid === false ? stale.reason : null).toBe("superseded");
		expect(stale.valid === false && stale.reason === "superseded" ? stale.current : null).toBe(2);

		const current = await validateFence(second.id, 2);
		expect(current.valid).toBe(true);
	});

	it("distinguishes a wrong token from a superseded one", async () => {
		const only = await insertSandbox({ status: "ready", createdAt: NOW });
		const wrong = await validateFence(only.id, 7);
		expect(wrong.valid === false ? wrong.reason : null).toBe("token_mismatch");
		expect(wrong.valid === false && wrong.reason === "token_mismatch" ? wrong.expected : null).toBe(1);
	});

	it("refuses a sandbox the lifecycle has already closed", async () => {
		const reaped = await insertSandbox({ status: "stale", createdAt: NOW });
		const verdict = await validateFence(reaped.id, 1);
		expect(verdict.valid === false ? verdict.reason : null).toBe("lifecycle_closed");
	});

	it("still admits a box marked failed, because a slow boot may yet come up", async () => {
		const late = await insertSandbox({ status: "failed", createdAt: NOW });
		expect((await validateFence(late.id, 1)).valid).toBe(true);
	});

	it("gives adjacent attempts distinct tokens even inside one millisecond", async () => {
		// Both callers see the same clock. Without the strictly-increasing `created_at`
		// in `openAttempt`, the tie is broken by a random uuid and the newer row can
		// compute the lower ordinal — at which point it refuses its own writes forever.
		await ensureSandbox({ orgId, sessionId, provider, now: NOW });
		await stopSandbox((await sandboxRows())[0]!.id, "stopped_by_operator", { provider, now: NOW });
		await ensureSandbox({ orgId, sessionId, provider, now: NOW });

		const rows = await sandboxRows();
		expect(rows).toHaveLength(2);
		expect(rows[0]!.createdAt.getTime()).toBeLessThan(rows[1]!.createdAt.getTime());
		expect(await validateFence(rows[1]!.id, 2)).toMatchObject({ valid: true });
	});
});

// ---------------------------------------------------------------------------
// The shared circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
	const overrides: RepoOverrides = {
		circuitFailureThreshold: 3,
		circuitWindowMs: 300_000,
		circuitCooldownMs: 60_000,
	};

	it("opens on the threshold failure and not before it", async () => {
		expect((await readCircuit(orgId, "fake", NOW, overrides)).decision.state).toBe("closed");

		await recordProviderFailure(orgId, "fake", "transient", NOW, overrides);
		expect((await readCircuit(orgId, "fake", NOW, overrides)).decision.state).toBe("closed");
		await recordProviderFailure(orgId, "fake", "rate_limited", NOW, overrides);
		expect((await readCircuit(orgId, "fake", NOW, overrides)).decision.state).toBe("closed");

		const third = await recordProviderFailure(orgId, "fake", "transient", NOW, overrides);
		expect(third.transition).toBe("opened");

		const open = (await readCircuit(orgId, "fake", NOW, overrides)).decision;
		expect(open.state).toBe("open");
		expect(open.state === "open" ? open.retryAfterMs : null).toBe(60_000);
		expect(open.state === "open" ? open.failures : null).toBe(3);
	});

	it("never opens on invalid_config, however many times it happens", async () => {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const record = await recordProviderFailure(orgId, "fake", "invalid_config", NOW, overrides);
			expect(record.contribution).toBe("ignored");
		}

		// Retrying a typo helps nobody, and an open circuit would hide a concurrent
		// real outage behind a configuration mistake.
		expect((await readCircuit(orgId, "fake", NOW, overrides)).decision.state).toBe("closed");
		const [row] = await db
			.select()
			.from(circuitBreakers)
			.where(and(eq(circuitBreakers.orgId, orgId), eq(circuitBreakers.provider, "fake")));
		expect(row).toBeUndefined();
	});

	it("is shared across sessions, so the second session pays nothing to discover an outage", async () => {
		const other = await createSession({ orgId, title: "Another room", createdBy: "@ada" });
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await recordProviderFailure(orgId, "fake", "transient", NOW, overrides);
		}

		const outcome = await ensureSandbox({
			orgId,
			sessionId: other.id,
			provider,
			now: NOW,
			repoOverrides: overrides,
		});
		expect(outcome.kind === "refused" ? outcome.reason : null).toBe("circuit_open");
		// The whole reason the breaker is a table rather than a field on a session.
		expect(provider.createCalls).toHaveLength(0);
	});

	it("restarts the streak once the window has elapsed, at the exact boundary", async () => {
		await recordProviderFailure(orgId, "fake", "transient", NOW, overrides);
		await recordProviderFailure(orgId, "fake", "transient", NOW, overrides);

		// Exactly one window later: the older streak has aged out in the writer for
		// the same reason it has in the reader, so this is failure one of a new run.
		const later = new Date(NOW.getTime() + 300_000);
		const restarted = await recordProviderFailure(orgId, "fake", "transient", later, overrides);
		expect(restarted.consecutiveFailures).toBe(1);
		expect((await readCircuit(orgId, "fake", later, overrides)).decision.state).toBe("closed");
	});

	it("is cleared by the spawn that proves the provider works", async () => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await recordProviderFailure(orgId, "fake", "transient", NOW, overrides);
		}
		expect((await recordProviderSuccess(orgId, "fake")).reset).toBe(true);
		expect((await readCircuit(orgId, "fake", NOW, overrides)).decision.state).toBe("closed");
	});

	it("clears itself when a spawn succeeds through the saga", async () => {
		await recordProviderFailure(orgId, "fake", "transient", NOW, overrides);
		await ensureSandbox({ orgId, sessionId, provider, now: NOW, repoOverrides: overrides });

		const [row] = await db
			.select()
			.from(circuitBreakers)
			.where(and(eq(circuitBreakers.orgId, orgId), eq(circuitBreakers.provider, "fake")));
		expect(row!.consecutiveFailures).toBe(0);
		expect(row!.openedAt).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The deadline handlers, each alone and each twice
// ---------------------------------------------------------------------------

describe("deadline handlers", () => {
	const overrides: RepoOverrides = {
		sandboxInactivityTimeoutMs: 1_000,
		sandboxStaleHeartbeatMs: 1_000,
		sandboxBootTimeoutMs: 1_000,
		agentTurnTimeoutMs: 1_000,
	};

	it("onInactivity stops an idle box, and running it twice stops it once", async () => {
		const row = await insertSandbox({
			status: "ready",
			createdAt: new Date(NOW.getTime() - 60_000),
			externalId: "fake-1",
			readyAt: new Date(NOW.getTime() - 60_000),
			lastHeartbeatAt: NOW,
		});
		provider.boxes.set("fake-1", { externalId: "fake-1", attemptId: row.id, state: "running" });
		await db
			.update(sessions)
			.set({ lastActivityAt: new Date(NOW.getTime() - 60_000) })
			.where(eq(sessions.id, sessionId));

		const first = await onInactivity(NOW, { orgId, provider, repoOverrides: overrides });
		expect(first.acted).toEqual([row.id]);

		const second = await onInactivity(NOW, { orgId, provider, repoOverrides: overrides });
		expect(second.acted).toEqual([]);
		expect(provider.stopCalls).toEqual(["fake-1"]);
		expect(await eventsOfType("sandbox_stopped")).toHaveLength(1);

		const [after] = await sandboxRows();
		expect(after!.status).toBe("stopped");
		expect(after!.failureReason).toBe("inactivity_timeout");
		// The persisted status is what blocks reconnection — a bridge that comes back
		// after the reap is refused by lifecycle state, not by a closed socket.
		expect(await heartbeat(row.id, NOW)).toMatchObject({
			accepted: false,
			reason: "lifecycle_closed",
		});
	});

	it("onInactivity leaves a box alone while somebody is still using the session", async () => {
		const row = await insertSandbox({
			status: "ready",
			createdAt: new Date(NOW.getTime() - 60_000),
			externalId: "fake-1",
			readyAt: new Date(NOW.getTime() - 60_000),
		});
		await db.update(sessions).set({ lastActivityAt: NOW }).where(eq(sessions.id, sessionId));

		const report = await onInactivity(NOW, { orgId, provider, repoOverrides: overrides });
		expect(report.examined).toBe(1);
		expect(report.acted).toEqual([]);
		expect((await sandboxRows())[0]!.status).toBe("ready");
		expect(row.status).toBe("ready");
	});

	it("onStaleHeartbeat marks a silent box stale, idempotently", async () => {
		const row = await insertSandbox({
			status: "ready",
			createdAt: new Date(NOW.getTime() - 60_000),
			externalId: "fake-1",
			readyAt: new Date(NOW.getTime() - 60_000),
			lastHeartbeatAt: new Date(NOW.getTime() - 30_000),
		});
		provider.boxes.set("fake-1", { externalId: "fake-1", attemptId: row.id, state: "running" });
		await db.update(sessions).set({ lastActivityAt: NOW }).where(eq(sessions.id, sessionId));

		const first = await onStaleHeartbeat(NOW, { orgId, provider, repoOverrides: overrides });
		expect(first.acted).toEqual([row.id]);
		const second = await onStaleHeartbeat(NOW, { orgId, provider, repoOverrides: overrides });
		expect(second.acted).toEqual([]);

		const [after] = await sandboxRows();
		// `stale` rather than `stopped`: one of those means "we shut it down", the
		// other means "it vanished", and only one of them is worth investigating.
		expect(after!.status).toBe("stale");
		expect(after!.failureReason).toBe("heartbeat_lost");
		expect(provider.stopCalls).toEqual(["fake-1"]);
	});

	it("onStaleHeartbeat does not reap a box that has not finished booting", async () => {
		await insertSandbox({ status: "spawning", createdAt: new Date(NOW.getTime() - 60_000) });
		const report = await onStaleHeartbeat(NOW, { orgId, provider, repoOverrides: overrides });
		// It is not supposed to be heartbeating during a four-minute `npm ci`; that
		// box belongs to the connecting watchdog, which measures the thing that is
		// actually late.
		expect(report.acted).toEqual([]);
		expect((await sandboxRows())[0]!.status).toBe("spawning");
	});

	it("onConnectingTimeout fails a late boot and reaps the orphan it left", async () => {
		const row = await insertSandbox({
			status: "requested",
			createdAt: new Date(NOW.getTime() - 60_000),
		});
		provider.boxes.set("fake-orphan", {
			externalId: "fake-orphan",
			attemptId: row.id,
			state: "running",
		});

		const first = await onConnectingTimeout(NOW, { orgId, provider, repoOverrides: overrides });
		expect(first.acted).toEqual([row.id]);
		// The box nobody has a handle on is found by its attempt label and stopped.
		// Without this the container runs until somebody reads an invoice.
		expect(provider.stopCalls).toEqual(["fake-orphan"]);

		const second = await onConnectingTimeout(NOW, { orgId, provider, repoOverrides: overrides });
		expect(second.acted).toEqual([]);
		expect(provider.stopCalls).toEqual(["fake-orphan"]);
		expect((await sandboxRows())[0]!.status).toBe("failed");
	});

	it("onExecutionTimeout ends a runaway turn without touching the box", async () => {
		const box = await insertSandbox({
			status: "ready",
			createdAt: new Date(NOW.getTime() - 60_000),
			externalId: "fake-1",
			readyAt: new Date(NOW.getTime() - 60_000),
			lastHeartbeatAt: NOW,
		});
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "fix the retry bug" });
		const delivered = await dequeuePrompt(orgId, sessionId);
		await db
			.update(sessionPrompts)
			.set({ deliveredAt: new Date(NOW.getTime() - 60_000) })
			.where(eq(sessionPrompts.id, delivered!.id));

		const first = await onExecutionTimeout(NOW, { orgId, provider, repoOverrides: overrides });
		expect(first.acted).toEqual([delivered!.id]);
		const second = await onExecutionTimeout(NOW, { orgId, provider, repoOverrides: overrides });
		expect(second.acted).toEqual([]);

		const [prompt] = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.id, delivered!.id));
		expect(prompt!.status).toBe("timed_out");
		expect(await eventsOfType("prompt_finished")).toHaveLength(1);
		// A long turn is not evidence of a broken container: the box may have three
		// more prompts queued behind this one.
		const [after] = await sandboxRows();
		expect(after!.status).toBe("ready");
		expect(after!.id).toBe(box.id);
		expect(provider.stopCalls).toEqual([]);
	});

	it("sweepDeadlines dispatches to all four and stays idempotent as a whole", async () => {
		const row = await insertSandbox({
			status: "ready",
			createdAt: new Date(NOW.getTime() - 60_000),
			externalId: "fake-1",
			readyAt: new Date(NOW.getTime() - 60_000),
			lastHeartbeatAt: new Date(NOW.getTime() - 60_000),
		});
		provider.boxes.set("fake-1", { externalId: "fake-1", attemptId: row.id, state: "running" });
		await db
			.update(sessions)
			.set({ lastActivityAt: new Date(NOW.getTime() - 60_000) })
			.where(eq(sessions.id, sessionId));

		const first = await sweepDeadlines(NOW, { orgId, provider, repoOverrides: overrides });
		// Idle and unheartbeating at once: the first handler to act wins the
		// compare-and-set and the second finds nothing, rather than both writing.
		expect(first.inactivity.acted).toEqual([row.id]);
		expect(first.staleHeartbeat.acted).toEqual([]);

		const second = await sweepDeadlines(NOW, { orgId, provider, repoOverrides: overrides });
		expect(second.inactivity.acted).toEqual([]);
		expect(second.staleHeartbeat.acted).toEqual([]);
		expect(second.connecting.acted).toEqual([]);
		expect(second.execution.acted).toEqual([]);
		expect(provider.stopCalls).toEqual(["fake-1"]);
	});
});
