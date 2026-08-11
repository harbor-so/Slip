import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The coordination tests share one Postgres and truncate between cases, so
		// they must not run in parallel files.
		fileParallelism: false,
		env: {
			DATABASE_URL: process.env.DATABASE_URL ?? "postgres://slip:slip@localhost:5433/slip",
		},
	},
});
