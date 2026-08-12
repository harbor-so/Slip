/**
 * Every channel in the org.
 *
 * The server component does the two things only it can — prove the viewer is in
 * an org and load the first list — then hands both to the `web/` client
 * component, which keeps the list live off the change feed and owns creation.
 * The access rules that actually bite (a private direct channel) are still
 * enforced at the API, not by hiding a row from this list.
 */

import { listChannels } from "../../lib/chat.js";
import { currentSession } from "../../lib/session.js";
import { Empty } from "../../components/ui.js";
import { ChannelList } from "@web/chat/ChannelList.js";
import type { ChannelSummary } from "@web/lib/api.js";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
	const viewer = await currentSession();
	if (!viewer) return <Empty title="Not signed in" hint="Sign in to see channels." />;

	const channels = await listChannels(viewer.orgId);
	const seed: ChannelSummary[] = channels.map((channel) => ({
		id: channel.id,
		key: channel.key,
		kind: channel.kind,
		title: channel.title,
		lastActivityAt: channel.lastActivityAt.toISOString(),
	}));

	return <ChannelList seed={seed} viewerName={viewer.userName ?? "you"} />;
}
