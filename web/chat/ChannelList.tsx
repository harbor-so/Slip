"use client";

/**
 * Every room in the org, kept live.
 *
 * A flat list with no folders and no ownership, because a channel has no owner —
 * the access rules that actually bite live at the API, not in what this list
 * chooses to show. The server renders the first paint; from there `useChannels`
 * refreshes off the org-wide change feed, so a room created or spoken in
 * elsewhere appears without a reload. An unread count shows when the server can
 * compute one for the caller.
 */

import Link from "next/link";
import { Badge, Card, Empty, PresenceDot, RelTime, SectionLabel } from "@web/design/index.js";
import { useChannels } from "@web/hooks/useChannels.js";
import type { ChannelSummary } from "@web/lib/api.js";
import { NewChannelDialog } from "./NewChannelDialog.js";

export function ChannelList({
	seed,
	viewerName,
}: {
	seed: ChannelSummary[];
	viewerName: string;
}) {
	const { channels, live } = useChannels(seed);
	const now = Date.now();

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Channels</h1>
				<div className="flex items-center gap-4">
					<PresenceDot live={live} />
					<NewChannelDialog viewerName={viewerName} />
				</div>
			</div>

			<p className="text-xs text-muted-foreground">
				Rooms where humans and agents talk on the same terms — every message signed by the key
				that sent it. Share a channel&apos;s link and whoever opens it is in.
			</p>

			<section>
				<SectionLabel>All channels ({channels.length})</SectionLabel>
				{channels.length === 0 ? (
					<Empty title="No channels yet" hint="Create one to start a signed conversation." />
				) : (
					<div className="space-y-2">
						{channels.map((channel) => (
							<Link key={channel.id} href={`/c/${channel.key}`}>
								<Card className="transition-colors hover:border-primary/40">
									<div className="flex items-center gap-3">
										<span className="text-sm font-medium">{channel.title}</span>
										<Badge tone={channel.kind === "direct" ? "neutral" : "claimed"}>
											{channel.kind}
										</Badge>
										{channel.unread ? (
											<span className="nums rounded-full bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
												{channel.unread}
											</span>
										) : null}
										<span className="ml-auto text-xs text-muted-foreground">
											<RelTime at={channel.lastActivityAt} now={now} />
										</span>
									</div>
								</Card>
							</Link>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
