/**
 * Deciding whether the agent pushed.
 *
 * Harbor does not run the push — the agent does, whenever it likes — so the only
 * way to know is to look at git afterwards and interpret what it says. The
 * interesting cases are the ones that are tedious to stage against a real
 * remote, which is exactly why this decision is pure and tested here rather than
 * discovered in production: a false "pushed" makes Harbor open a pull request
 * for a branch the host does not have, and the failure surfaces minutes later as
 * a confusing 422 rather than as the missing push it actually is.
 */

import { describe, expect, it } from "vitest";
import { pushVerdict } from "./boot-decisions.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("pushVerdict", () => {
	it("reports when the remote tip matches the local tip", () => {
		expect(
			pushVerdict({
				localBranch: "harbor/lse_abc123",
				localSha: SHA,
				remoteSha: SHA,
				lastReported: null,
			}),
		).toEqual({ kind: "report", branch: "harbor/lse_abc123", sha: SHA });
	});

	it("stays silent when the branch was committed but never pushed", () => {
		// The commonest false positive: work exists locally and the remote has
		// never heard of it. Reporting here opens a pull request for a branch
		// GitHub cannot see.
		expect(
			pushVerdict({ localBranch: "feature", localSha: SHA, remoteSha: null, lastReported: null }),
		).toEqual({ kind: "silent", reason: "not_pushed" });
	});

	it("stays silent when the remote is behind the local tip", () => {
		// A push that failed partway, or new commits since. Not news yet.
		expect(
			pushVerdict({ localBranch: "feature", localSha: SHA, remoteSha: OTHER, lastReported: null }),
		).toEqual({ kind: "silent", reason: "not_pushed" });
	});

	it("does not report the same push twice", () => {
		// Without this a five-turn session opens the same pull request five times.
		expect(
			pushVerdict({ localBranch: "feature", localSha: SHA, remoteSha: SHA, lastReported: SHA }),
		).toEqual({ kind: "silent", reason: "already_reported" });
	});

	it("reports again when the branch moves", () => {
		// A second push to the same branch IS news — it is what makes the "adopted"
		// path in createPullRequest reachable rather than dead code.
		expect(
			pushVerdict({ localBranch: "feature", localSha: OTHER, remoteSha: OTHER, lastReported: SHA }),
		).toEqual({ kind: "report", branch: "feature", sha: OTHER });
	});

	it("stays silent on a detached HEAD, in both spellings", () => {
		// `rev-parse --abbrev-ref HEAD` answers "HEAD" on a detached head; some git
		// versions answer the sha. Neither is a branch to open a pull request from.
		expect(
			pushVerdict({ localBranch: "HEAD", localSha: SHA, remoteSha: SHA, lastReported: null }).kind,
		).toBe("silent");
		expect(
			pushVerdict({ localBranch: SHA, localSha: SHA, remoteSha: SHA, lastReported: null }),
		).toEqual({ kind: "silent", reason: "detached" });
	});

	it("stays silent rather than guessing when git could not be read", () => {
		// Every git call in the reporter yields null on failure. A broken
		// `ls-remote` must not turn a completed turn into a false push report.
		expect(
			pushVerdict({ localBranch: null, localSha: null, remoteSha: null, lastReported: null }),
		).toEqual({ kind: "silent", reason: "unreadable" });
		expect(
			pushVerdict({ localBranch: "feature", localSha: null, remoteSha: SHA, lastReported: null })
				.kind,
		).toBe("silent");
	});

	it("ignores surrounding whitespace from git's output", () => {
		expect(
			pushVerdict({
				localBranch: " feature \n",
				localSha: ` ${SHA} `,
				remoteSha: `${SHA}\t`,
				lastReported: null,
			}),
		).toEqual({ kind: "report", branch: "feature", sha: SHA });
	});
});
