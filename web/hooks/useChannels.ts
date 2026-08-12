"use client";

/**
 * The org's channel list, kept current without a poll.
 *
 * First paint comes from the server component (the route already loads channels
 * for SEO-less-but-instant render); this hook takes that as its seed and then
 * refreshes off the org-wide change feed, so a room created or spoken in
 * elsewhere shows up here without the operator reloading. It reads the list
 * endpoint rather than the chat stream because the interest is cross-channel —
 * which rooms exist and which moved — not the contents of any one of them.
 */

import { useCallback, useEffect, useState } from "react";
import { listChannels, type ChannelSummary } from "@web/lib/api.js";
import { useOrgStream } from "./useOrgStream.js";

export function useChannels(seed: ChannelSummary[], as?: string): {
	channels: ChannelSummary[];
	live: boolean;
} {
	const [channels, setChannels] = useState<ChannelSummary[]>(seed);

	const refresh = useCallback(async () => {
		try {
			const { channels: fresh } = await listChannels(as);
			setChannels(fresh);
		} catch {
			// Keep the last good list; the next change re-tries.
		}
	}, [as]);

	const { live } = useOrgStream(() => {
		void refresh();
	});

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return { channels, live };
}
