/**
 * .env.example must describe the deployment that exists.
 *
 * The audit found four variables in the example file that nothing anywhere
 * read — including GITHUB_APP_CLIENT_ID/SECRET, whose REAL names are
 * GITHUB_CLIENT_ID/SECRET. A self-hoster who filled in the _APP_ pair got the
 * deployment-wide attribution degradation with nothing telling them why: the
 * example file taught them the wrong variable. Dead example variables are not
 * clutter, they are instructions to misconfigure.
 *
 * So: every variable named in .env.example must be read somewhere in shipped
 * source, and the knobs a real deployment needs must be present in the file.
 * The scan is textual, same as the config lint — a variable read via a
 * constructed string would evade it, and none is.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(ts|tsx|mjs|js|sh)$/.test(entry)) out.push(full);
	}
	return out;
}

/** Every variable the example file names, assignments and commented knobs alike. */
function declaredVariables(): string[] {
	const example = readFileSync(join(ROOT, ".env.example"), "utf8");
	const names = new Set<string>();
	for (const line of example.split("\n")) {
		const match = line.match(/^#?([A-Z][A-Z0-9_]+)=/);
		if (match) names.add(match[1]!);
	}
	return [...names];
}

function shippedSource(): string {
	const roots = ["src", "runtime", "scripts", "integrations", "sandbox"]
		.map((dir) => join(ROOT, dir))
		.filter((dir) => {
			try {
				return statSync(dir).isDirectory();
			} catch {
				return false;
			}
		});
	return roots
		.flatMap((dir) => walk(dir))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
}

describe(".env.example drift", () => {
	it("every declared variable is read somewhere in shipped source", () => {
		const source = shippedSource();
		// The webhook secrets are read through a constructed name —
		// process.env[`${type.toUpperCase()}_WEBHOOK_SECRET`] in the webhook
		// route — which a textual scan cannot see. Verified by reading that
		// route; listed here so the scan stays honest about its blind spot.
		const readDynamically = new Set([
			"GITHUB_WEBHOOK_SECRET",
			"SLACK_WEBHOOK_SECRET",
			"LINEAR_WEBHOOK_SECRET",
		]);
		const dead = declaredVariables()
			.filter((name) => !readDynamically.has(name))
			.filter((name) => !source.includes(name));
		expect(
			dead,
			`Variables in .env.example that nothing reads — an instruction to misconfigure:\n  ${dead.join(
				"\n  ",
			)}`,
		).toEqual([]);
	});

	it("the knobs a real deployment trips over are documented in the file", () => {
		const example = readFileSync(join(ROOT, ".env.example"), "utf8");
		// Each of these was found missing by the audit while being the exact knob
		// a class of deployment cannot run without discovering: the hook budgets
		// (a slow monorepo), SCM_HOST (GitHub Enterprise Server), the heartbeat
		// pair (flaky networks), the metrics token (internet-reachable installs).
		for (const name of [
			"HARBOR_SETUP_TIMEOUT_MS",
			"HARBOR_START_TIMEOUT_MS",
			"HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS",
			"HARBOR_SANDBOX_STALE_HEARTBEAT_MS",
			"HARBOR_LEASE_MINUTES",
			"HARBOR_METRICS_TOKEN",
			"SCM_HOST",
		]) {
			expect(example, `${name} is missing from .env.example`).toContain(name);
		}
	});

	it("the fallback DSN literal lives in exactly the places that own it", () => {
		// The dev DSN used to be pasted into three SSE routes; databaseUrl() in
		// src/db/index.ts is now the one resolution. A new paste is a new place
		// for a changed default to be missed.
		const literal = "postgres://harbor:harbor@localhost:5433/harbor";
		const offenders = ["src", "runtime", "scripts"]
			.map((dir) => join(ROOT, dir))
			.flatMap((dir) => walk(dir))
			.filter((file) => !/\.test\.(ts|mts)$/.test(file))
			.filter((file) => readFileSync(file, "utf8").includes(literal))
			.map((file) => file.slice(ROOT.length + 1));
		expect(offenders.sort()).toEqual(["src/db/index.ts"]);
	});
});
