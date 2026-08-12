"use client";

/**
 * The org-wide change feed, as a hook.
 *
 * `GET /api/stream` is the same SSE feed the dashboard's `LiveRefresh` uses:
 * Postgres `LISTEN/NOTIFY` fanned out over Server-Sent Events, emitting a
 * `change` with a `verb` (`run_output`, `run_finished`, and the rest) whenever
 * something moves in the org. Like the chat stream, the payload is only a hint —
 * "something changed" — so the consumer refetches the authoritative data rather
 * than trusting a body on the wire. `onChange` is held in a ref so a caller can
 * pass an inline closure without re-subscribing on every render.
 */

import { useEffect, useRef, useState } from "react";

export interface OrgChange {
	verb?: string;
	[key: string]: unknown;
}

export function useOrgStream(onChange?: (change: OrgChange) => void): { live: boolean } {
	const [live, setLive] = useState(false);
	const handlerRef = useRef(onChange);
	handlerRef.current = onChange;

	useEffect(() => {
		const source = new EventSource("/api/stream", { withCredentials: true });
		source.addEventListener("ready", () => setLive(true));
		source.onerror = () => setLive(false);
		source.addEventListener("change", (message) => {
			let change: OrgChange = {};
			try {
				change = JSON.parse((message as MessageEvent).data) as OrgChange;
			} catch {
				// A malformed frame is a wake signal too; hand the caller an empty change.
			}
			handlerRef.current?.(change);
		});
		return () => source.close();
	}, []);

	return { live };
}
