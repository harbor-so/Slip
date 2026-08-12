/**
 * One test run at a time, per database.
 *
 * The suite shares a single Postgres and truncates between cases, which is a
 * deliberate choice — the guarantees under test are database indexes and lock
 * behaviour, and a mock happily passes a read-then-write check that races. The
 * cost of that choice is that two concurrent runs destroy each other's data.
 *
 * That failure mode is genuinely nasty to diagnose, because it does not look like
 * a concurrency problem. It looks like `insert or update on table "repos"
 * violates foreign key constraint` two lines after the org was successfully
 * inserted, or `No task matching <uuid>` for a task the test just created — as
 * though the code under test were broken in some deep, intermittent way. It is
 * worth an hour of anybody's afternoon, and it costs whatever fraction of a
 * second this file takes to prevent.
 *
 * Concurrent runs are easy to start by accident: an agent running `npm test`
 * while a human runs it in another terminal, a CI job overlapping a re-run, a
 * `timeout` that kills the wrapper while vitest's forked children keep going.
 *
 * The lock is a Postgres session advisory lock held on a dedicated connection for
 * the lifetime of the run, so it is released automatically if the process is
 * killed — including with SIGKILL, since the backend dies with the socket. There
 * is nothing to clean up and no stale lock file to delete.
 *
 * It is `try`, not a blocking acquire, and the failure message says what to do.
 * Blocking would be worse: a developer would sit watching a suite that appears to
 * hang, which is exactly the ambiguity this file exists to remove.
 */

import postgres from "postgres";

/**
 * A constant, so every runner competes for the same lock. Two arbitrary integers
 * rather than `hashtext` of a string, because the value has to be stable across
 * Postgres versions and reproducible by anyone reading a `pg_locks` row.
 */
const LOCK_NAMESPACE = 4919;
const LOCK_ID = 1;

let holder: postgres.Sql | null = null;

export async function setup(): Promise<void> {
	const url = process.env.DATABASE_URL ?? "postgres://harbor:harbor@localhost:5433/harbor";
	const client = postgres(url, { max: 1, onnotice: () => {} });

	const [row] = await client`
		select pg_try_advisory_lock(${LOCK_NAMESPACE}::int, ${LOCK_ID}::int) as acquired
	`;

	if (!row?.acquired) {
		// Name the other holder if we can. "Another run is in progress" is much
		// easier to act on when it comes with a pid to look at.
		const others = await client`
			select a.pid, a.application_name, a.state, a.backend_start
			from pg_locks l
			join pg_stat_activity a on a.pid = l.pid
			where l.locktype = 'advisory'
				and l.classid = ${LOCK_NAMESPACE}
				and l.objid = ${LOCK_ID}
				and l.granted
		`.catch(() => []);

		await client.end({ timeout: 1 }).catch(() => {});

		const detail = others.length
			? others
					.map(
						(other) =>
							`  pid ${other.pid} (${other.application_name || "unknown"}), started ${
								other.backend_start instanceof Date
									? other.backend_start.toISOString()
									: String(other.backend_start)
							}`,
					)
					.join("\n")
			: "  (the holding backend could not be identified)";

		throw new Error(
			"Another test run is already using this database.\n\n"
				+ `${detail}\n\n`
				+ "The suite truncates between cases, so two runs destroy each other's data — and "
				+ "the symptom is not obviously a concurrency problem. It looks like foreign key "
				+ "violations and rows disappearing immediately after they were inserted.\n\n"
				+ "Wait for the other run, or point this one at its own database:\n"
				+ "  DATABASE_URL=postgres://harbor:harbor@localhost:5433/harbor_test npx vitest run\n\n"
				+ "If you are sure nothing else is running, a killed run may have left an orphan:\n"
				+ "  pkill -f vitest",
		);
	}

	// Held for the lifetime of the run. `teardown` releases it; a crash releases it
	// when the backend dies with the socket.
	holder = client;
}

export async function teardown(): Promise<void> {
	if (!holder) return;
	await holder`select pg_advisory_unlock(${LOCK_NAMESPACE}::int, ${LOCK_ID}::int)`.catch(() => {});
	await holder.end({ timeout: 1 }).catch(() => {});
	holder = null;
}
