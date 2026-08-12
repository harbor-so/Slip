/**
 * Tests for the lint rule, including its error message.
 *
 * Testing a lint rule's *message* looks like excessive ceremony until you have
 * watched one rot. A rule that fires with "Error: violation" gets an
 * eslint-disable comment and never fires usefully again; a rule that explains
 * what to do instead gets obeyed. The message is the feature, so the message is
 * under test — if somebody shortens it to something unhelpful, this fails.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM JavaScript with no type declarations, deliberately:
// the lint rule must be runnable as a bare `node scripts/lint-config.mjs` in CI
// without a TypeScript toolchain in front of it.
import { findViolations, lintTree } from "./lint-config.mjs";

describe("finding hardcoded tunables", () => {
	it("fires on a module-level timeout constant", () => {
		const found = findViolations("const BOOT_TIMEOUT_MS = 90_000;\n", "src/example.ts");
		expect(found).toHaveLength(1);
		expect(found[0].name).toBe("BOOT_TIMEOUT_MS");
	});

	it("fires on camelCase and on an exported constant", () => {
		expect(findViolations("const pollIntervalMs = 5000;\n", "src/a.ts")).toHaveLength(1);
		expect(findViolations("export const MAX_RETRIES = 3;\n", "src/a.ts")).toHaveLength(1);
		expect(findViolations("const CIRCUIT_COOLDOWN = 60000;\n", "src/a.ts")).toHaveLength(1);
	});

	it("fires through a type annotation and a trailing comment", () => {
		const found = findViolations(
			"const STALE_THRESHOLD_MS: number = 45_000; // three heartbeats\n",
			"src/a.ts",
		);
		expect(found).toHaveLength(1);
	});

	/**
	 * A rule that fires on everything gets turned off. These are the cases that
	 * would produce noise, and each is a real pattern in this codebase.
	 */
	it("does not fire on identifiers that are not tunables", () => {
		expect(findViolations("const IV_BYTES = 12;\n", "src/a.ts")).toHaveLength(0);
		expect(findViolations("const KEY_BYTES = 32;\n", "src/a.ts")).toHaveLength(0);
		expect(findViolations("const VERSION = 1;\n", "src/a.ts")).toHaveLength(0);
	});

	it("does not fire on non-numeric values or on inline numbers", () => {
		expect(findViolations('const TIMEOUT_MESSAGE = "too slow";\n', "src/a.ts")).toHaveLength(0);
		expect(findViolations("const MAX_ITEMS = items.length;\n", "src/a.ts")).toHaveLength(0);
		expect(findViolations("await sleep(30_000);\n", "src/a.ts")).toHaveLength(0);
	});

	it("does not fire inside a function body", () => {
		const source = "function f() {\n\tconst retryDelayMs = 1000;\n\treturn retryDelayMs;\n}\n";
		// Indented by a tab, so the module-level anchor does not match. Locals are
		// out of scope on purpose: the rule is about the deployment's configuration
		// surface, not about every number anyone ever writes.
		expect(findViolations(source, "src/a.ts")).toHaveLength(0);
	});

	it("honours a documented escape hatch on the line above", () => {
		const source =
			"// harbor-lint-allow-constant: the protocol fixes this at 30s\nconst PROTOCOL_TIMEOUT_MS = 30_000;\n";
		expect(findViolations(source, "src/a.ts")).toHaveLength(0);
	});
});

describe("the error message", () => {
	const [violation] = findViolations("const SPAWN_TIMEOUT_MS = 90_000;\n", "src/sandbox/x.ts");

	it("names the file and line", () => {
		expect(violation.message).toContain("src/sandbox/x.ts:1");
	});

	/** Without this, the reader knows they broke a rule but not how to comply. */
	it("says exactly what to do instead", () => {
		expect(violation.message).toContain("src/config.ts");
		expect(violation.message).toContain('setting("...")');
	});

	/** Without this, the rule reads as arbitrary and gets argued with. */
	it("says why the rule exists in terms of who it hurts", () => {
		expect(violation.message).toContain("fork the project");
		expect(violation.message).toContain("self-hoster");
	});

	it("names the escape hatch", () => {
		expect(violation.message).toContain("harbor-lint-allow-constant");
	});
});

describe("the tree as it actually stands", () => {
	/**
	 * The acceptance criterion, asserted rather than asserted-about: no hardcoded
	 * tunable exists anywhere in the shipped source. If this fails, the message
	 * printed by the rule tells whoever broke it what to do.
	 */
	it("has no hardcoded tunables", () => {
		const violations = lintTree(process.cwd());
		if (violations.length > 0) {
			throw new Error(
				`${violations.length} hardcoded tunable(s):\n\n`
					+ violations.map((v: { message: string }) => v.message).join("\n\n"),
			);
		}
		expect(violations).toHaveLength(0);
	});
});
