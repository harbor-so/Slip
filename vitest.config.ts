import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The coordination tests share one Postgres and truncate between cases, so
		// they must not run in parallel files.
		fileParallelism: false,
		// ...and, for the same reason, two RUNS must not overlap either. This takes a
		// Postgres advisory lock for the lifetime of the suite and fails fast with an
		// explanation if another run holds it. See vitest.setup.ts: the failure mode
		// it prevents does not look like a concurrency problem, it looks like rows
		// vanishing immediately after they were inserted, and it costs an afternoon.
		globalSetup: ["./vitest.setup.ts"],
		// The protocol suite boots an HTTP server and opens real MCP clients; tearing
		// those down plus the Postgres pool can exceed the 10s default.
		hookTimeout: 30_000,
		testTimeout: 30_000,
		env: {
			DATABASE_URL: process.env.DATABASE_URL ?? "postgres://harbor:harbor@localhost:5433/harbor",
		},
	},
});
