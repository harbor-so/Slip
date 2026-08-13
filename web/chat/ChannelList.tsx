"use client";

/**
 * Every room in the org — the first page migrated onto tandem's component base.
 *
 * A flat list with no folders and no ownership, because a channel has no owner;
 * the access rules that actually bite live at the API, not in what this list
 * shows. The server renders the first paint and `useChannels` keeps it live off
 * the org change feed, so a room created or spoken in elsewhere appears without
 * a reload.
 */

import Link from "next/link";
import { Badge, Empty, Pulse, SectionLabel, relativeTime, type Tone } from "@web/ui/index.js";
import { useChannels } from "@web/hooks/useChannels.js";
import type { ChannelSummary } from "@web/lib/api.js";
import { NewChannelDialog } from "./NewChannelDialog.js";

const KIND_TONE: Record<string, Tone> = { group: "accent", task: "accent", direct: "neutral" };

export function ChannelList({ seed, viewerName }: { seed: ChannelSummary[]; viewerName: string }) {
	const { channels, live } = useChannels(seed);
	const now = Date.now();

	return (
		<div className="mx-auto max-w-4xl">
			<header className="flex items-start justify-between gap-4 border-b border-line pb-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h1 className="text-sm font-semibold">Channels</h1>
						{live ? (
							<span className="flex items-center gap-1.5 text-[11px] text-good">
								<Pulse />
								live
							</span>
						) : null}
					</div>
					<p className="mt-1 max-w-xl text-xs text-faint">
						Rooms where humans and agents talk on the same terms — every message signed by the
						key that sent it. Share a channel&apos;s link and whoever opens it is in.
					</p>
				</div>
				<NewChannelDialog viewerName={viewerName} />
			</header>

			<div className="mt-6">
				<SectionLabel className="mb-3">All channels ({channels.length})</SectionLabel>
				{channels.length === 0 ? (
					<Empty title="No channels yet." hint="Create one to start a signed conversation." />
				) : (
					<ul className="space-y-2">
						{channels.map((channel) => (
							<li key={channel.id}>
								<Link
									href={`/c/${channel.key}`}
									className="block rounded-panel border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong"
								>
									<div className="flex items-baseline gap-2">
										<h3 className="min-w-0 flex-1 truncate text-sm font-medium">
											{channel.title}
										</h3>
										<span className="nums shrink-0 text-xs text-faint">
											{relativeTime(new Date(channel.lastActivityAt).getTime(), now)}
										</span>
									</div>
									<div className="mt-2.5 flex flex-wrap items-center gap-2">
										<Badge tone={KIND_TONE[channel.kind] ?? "neutral"}>{channel.kind}</Badge>
										{channel.unread ? (
											<Badge tone="accent">
												{channel.unread === 1 ? "1 unread" : `${channel.unread} unread`}
											</Badge>
										) : null}
									</div>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
