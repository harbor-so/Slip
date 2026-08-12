/**
 * Every background loop in the product, in one registry.
 *
 * This file exists because of a specific, expensive failure: the sweeps were
 * written, documented, tested — and never scheduled. `sweepDeadlines`,
 * `tickSessions` and `compactSession` had zero production callers, so a
 * shipping deployment had no inactivity reaping (every sandbox billed until
 * the host died), no session queue advancement outside the request path, and
 * unbounded event growth. The test suite was green the whole time, because
 * each sweep was tested by calling it — nothing asserted that anything *would*
 * call it.
 *
 * The registry is the fix, in the only shape a test can enforce: a closed list
 * a test compares against the set of sweeps that exist. Adding a sweep without
 * registering it here fails `loops.test.ts` by name. `startBackgroundLoops`
 * then starts exactly the registry, so "registered" and "scheduled" cannot
 * drift apart.
 *
 * The MCP server is the process that owns these loops; the Next.js app
 * deliberately runs none (it is serverless-shaped and may have zero warm
 * instances at any moment). Every loop is safe on every replica — each one
 * either takes an advisory lock, is a compare-and-set over shared rows, or is
 * idempotent by construction — so running the MCP server twice doubles the
 * timeliness, not the actions.
 */

import { type SettingKey, setting, validateConfig } from "../config.js";
import { warnScmAttributionAtStartup } from "../git/credentials.js";
import { sweepProviderOrphans } from "../sandbox/orphans.js";
import { sweepDeadlines } from "../sandbox/manager.js";
import { tickAutomations } from "../triggers/automations.js";
import { compactEligibleSessions } from "./session-events.js";
import { tickSessions } from "./session-tick.js";
import { sweepExpiredClaims } from "./work.js";

/**
 * Closed set, on purpose: `backgroundLoops()` returns exactly one spec per
 * member, and the completeness test enumerates this list. A new loop starts
 * here, as a name, so forgetting every other step still fails a test.
 */
export const LOOP_NAMES = [
	"claims",
	"automations",
	"deadlines",
	"sessions",
	"compaction",
	"orphans",
] as const;
export type LoopName = (typeof LOOP_NAMES)[number];

export interface LoopSpec {
	name: LoopName;
	/**
	 * Resolved via `setting()` at start rather than captured as a number, so the
	 * registry itself contains no timing literal the config lint would have to
	 * chase.
	 */
	intervalSetting: SettingKey;
	run: (now: Date) => Promise<unknown>;
}

export function backgroundLoops(): LoopSpec[] {
	return [
		{
			// A backstop, not the mechanism — claim() already expires a stale holder
			// before it inserts. This buys timeliness: a dead agent's task reads as
			// open within a minute instead of at the next contention.
			name: "claims",
			intervalSetting: "claimSweepIntervalMs",
			run: () => sweepExpiredClaims(),
		},
		{
			// Rides the claim sweep's interval deliberately: both are periodic
			// reconciliations whose timeliness matters and whose exact cadence does
			// not, and a second knob would be a second thing to get wrong.
			name: "automations",
			intervalSetting: "claimSweepIntervalMs",
			run: () => tickAutomations(),
		},
		{
			// Inactivity, stale heartbeats, boot timeouts, execution timeouts. This
			// is the single largest lever on cost in the product: without it an
			// abandoned sandbox bills until the host dies.
			name: "deadlines",
			intervalSetting: "deadlineSweepIntervalMs",
			run: (now) => sweepDeadlines(now),
		},
		{
			// Advances sessions with queued prompts. This is the latency a prompt
			// waits when no request-path tick picked it up — the most user-visible
			// interval in the system.
			name: "sessions",
			intervalSetting: "sessionTickIntervalMs",
			run: (now) => tickSessions(now),
		},
		{
			// Bounds event growth. ADR 0001's claim that "old events are compacted
			// rather than accumulated" is only true while this runs.
			name: "compaction",
			intervalSetting: "compactionSweepIntervalMs",
			run: (now) => compactEligibleSessions(now),
		},
		{
			// The backstop for crash windows the saga cannot close on its own: a
			// container whose row is unreachable is invisible to everything else.
			name: "orphans",
			intervalSetting: "orphanSweepIntervalMs",
			run: (now) => sweepProviderOrphans(now),
		},
	];
}

export interface RunningLoops {
	stop(): void;
}

/**
 * Start every registered loop. One `setInterval` per spec, each tick wrapped so
 * a throwing pass is logged and the loop lives to run again — a sweep that dies
 * on its first bad pass is the "never scheduled" bug with extra steps. Timers
 * are unref'd so they never hold the process open, and `stop()` exists so tests
 * can run the scheduler with fake timers and tear it down.
 */
export function startBackgroundLoops(
	options: { onError?: (name: LoopName, error: unknown) => void } = {},
): RunningLoops {
	const onError =
		options.onError ?? ((name, error) => console.error(`[loops] ${name} tick failed:`, error));

	const timers = backgroundLoops().map((spec) =>
		setInterval(() => {
			spec.run(new Date()).catch((error) => onError(spec.name, error));
		}, setting(spec.intervalSetting) as number).unref(),
	);

	return {
		stop() {
			for (const timer of timers) clearInterval(timer);
		},
	};
}

/**
 * Everything a serving process must do once at boot, before taking traffic.
 *
 * `validateConfig` throws on an incoherent combination — the caller exits, by
 * design. `warnScmAttributionAtStartup` is the deploy-time half of ADR 0004's
 * loud-degradation guarantee: a deployment with no SCM OAuth configured falls
 * back to bot-attributed pull requests, and the ADR promises that this is said
 * at startup, naming the property lost, not discovered in a PR's byline weeks
 * later. It was dead code until this call existed — the function, its test and
 * the ADR all asserted a warning nothing ever emitted.
 */
export function runStartupChecks(): { attributionWarning: string | null } {
	validateConfig();
	return { attributionWarning: warnScmAttributionAtStartup() };
}
