#!/usr/bin/env node
/**
 * Fail the build on a hardcoded timeout, threshold or limit.
 *
 * This rule exists because the discipline it enforces is the kind that decays
 * silently. `src/config.ts` says every tunable is operator-configurable, and that
 * claim stays true only for as long as nobody writes
 * `const BOOT_TIMEOUT_MS = 90_000` halfway down a lifecycle file — at which point
 * the claim is false, nothing fails, and the self-hoster whose monorepo takes
 * four minutes to boot has to fork the project.
 *
 * A code-review convention does not catch this. A comment does not catch this.
 * A test that greps the source does, so that is what this is.
 *
 * The rule is deliberately narrow, because a broad one gets disabled. It fires on
 * a module-level `const` whose NAME says it is a duration or a limit and whose
 * VALUE is a numeric literal. It does not fire on:
 *
 *   - anything inside `src/config.ts`, which is where these belong;
 *   - test files, where a fixed timing boundary is the entire point of the test;
 *   - `fallback:` values inside the SETTINGS registry;
 *   - numbers used inline, which are usually array sizes and slice bounds.
 *
 * Its error message is asserted by `scripts/lint-config.test.ts`, because a lint
 * rule whose message rots into something unhelpful is a lint rule people learn to
 * silence rather than obey.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/**
 * Names that indicate a tunable. Matched case-insensitively against the whole
 * identifier, so `MAX_RETRIES` and `pollIntervalMs` both hit while `MAX_INT` and
 * `bufferSize` do not — the latter being an implementation detail rather than a
 * policy an operator would ever want to change.
 */
const TUNABLE_NAME = /(TIMEOUT|INTERVAL|_MS$|_SECONDS$|_DELAY|COOLDOWN|THRESHOLD|MAX_|_LIMIT|LIMIT_|RETENTION|BACKOFF|WINDOW_MS|TTL)/i;

const EXEMPT_FILES = new Set(["src/config.ts"]);

const EXEMPT_PATTERNS = [
	/\.test\.ts$/,
	/\.test\.mts$/,
	/^scripts\//,
	/^drizzle\//,
	/^node_modules\//,
	/^\.next\//,
];

/** `export const FOO_TIMEOUT_MS = 30_000;` and `const fooIntervalMs = 5000;` */
const MODULE_CONST = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([\d_]+)\s*;?\s*(?:\/\/.*)?$/;

/**
 * Walk back through the contiguous comment block above a line, looking for the
 * marker. Stops at the first line that is not a comment, so a marker attached to
 * some unrelated declaration ten lines up does not silently license this one.
 */
function hasAllowMarker(lines, index) {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const line = (lines[cursor] ?? "").trim();
		if (line === "") continue;
		const isComment = line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
		if (!isComment) return false;
		if (line.includes("harbor-lint-allow-constant:")) return true;
	}
	return false;
}

export function findViolations(source, file) {
	const violations = [];
	const lines = source.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const match = line.match(MODULE_CONST);
		if (!match) continue;

		const [, name, literal] = match;
		if (!TUNABLE_NAME.test(name)) continue;

		// An escape hatch, because there is always one legitimate case and forcing it
		// through the rule is how the rule gets deleted. It must say why, in the
		// comment block immediately above, so the exception is reviewable.
		//
		// The whole contiguous comment block is scanned rather than only the line
		// directly above. The first version checked one line, which meant a
		// well-written five-line justification did not suppress the rule and a
		// terse one did — training people to write the terse one. That is exactly
		// backwards for a mechanism whose entire value is the explanation.
		if (hasAllowMarker(lines, index)) continue;

		violations.push({
			file,
			line: index + 1,
			name,
			value: literal,
			message:
				`${file}:${index + 1}  ${name} is a hardcoded tunable.\n`
				+ `    Move it into the SETTINGS registry in src/config.ts and read it with `
				+ `setting("...").\n`
				+ `    Every timeout, threshold and limit in Harbor is operator-configurable and `
				+ `per-repository\n`
				+ `    overridable. A constant here means a self-hoster whose repository `
				+ `legitimately needs a\n`
				+ `    different value has to fork the project, which is the single most likely `
				+ `reason someone\n`
				+ `    abandons a self-hosted tool in its first week.\n`
				+ `    If this genuinely is not a tunable, rename it, or add `
				+ `"// harbor-lint-allow-constant: <why>" above it.`,
		});
	}

	return violations;
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

export function lintTree(root = ROOT) {
	const violations = [];
	for (const absolute of walk(root)) {
		const file = relative(root, absolute).replaceAll("\\", "/");
		if (EXEMPT_FILES.has(file)) continue;
		if (EXEMPT_PATTERNS.some((pattern) => pattern.test(file))) continue;
		violations.push(...findViolations(readFileSync(absolute, "utf8"), file));
	}
	return violations;
}

// Run as a script rather than imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
	const violations = lintTree();
	if (violations.length === 0) {
		console.log("lint-config: no hardcoded tunables found.");
		process.exit(0);
	}
	console.error(`lint-config: ${violations.length} hardcoded tunable(s).\n`);
	for (const violation of violations) console.error(`${violation.message}\n`);
	process.exit(1);
}
