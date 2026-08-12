import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The coordination tests share one Postgres and truncate between cases, so
		// they must not run in parallel files.
		fileParallelism: false,
		// The protocol suite boots an HTTP server and opens real MCP clients; tearing
		// those down plus the Postgres pool can exceed the 10s default.
		hookTimeout: 30_000,
		testTimeout: 30_000,
		env: {
			DATABASE_URL: process.env.DATABASE_URL ?? "postgres://harbor:harbor@localhost:5433/harbor",
		},
	},
});
