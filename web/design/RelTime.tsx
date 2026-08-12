/**
 * "22m ago", rendered from an absolute timestamp.
 *
 * Reuses `relTime` from the server-shared formatter so a duration reads the same
 * in the dashboard, the agent-facing text protocol and here — one vocabulary for
 * "how long ago". Kept a thin span so a parent that re-renders on every streamed
 * event (which the room does) keeps this current for free.
 */

import { relTime } from "~/lib/format.js";

export function RelTime({ at, suffix = "ago", now }: { at: string | number | Date; suffix?: string; now?: number }) {
	const then = at instanceof Date ? at.getTime() : new Date(at).getTime();
	const reference = now ?? Date.now();
	return (
		<span className="nums" title={new Date(then).toLocaleString()}>
			{relTime(reference - then)} {suffix}
		</span>
	);
}
