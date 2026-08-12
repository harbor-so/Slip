"use client";

/**
 * The conversation, grouped and attributed.
 *
 * Consecutive messages from one key collapse into a single run with one header —
 * a person saying three things in a row is one voice, not three — while a system
 * line (join/leave/create) renders on its own, centred and muted, because it is
 * the room narrating itself rather than anyone speaking. Reactions never appear
 * here as their own rows; they are folded onto the message they point at
 * (`tallyReactions`), which is the only place a reaction means anything.
 */

import { useEffect, useMemo, useRef } from "react";
import { Avatar, Badge, Empty, RelTime } from "@web/design/index.js";
import {
	groupByAuthor,
	replyTargetOf,
	shortKey,
	tallyReactions,
	type Member,
	type RoomEvent,
} from "@web/lib/events.js";
import { MessageItem } from "./MessageItem.js";

function systemLine(event: RoomEvent, who: string): string {
	if (event.kind === "channel_create") return `${who} created the channel`;
	if (event.kind === "join") return `${who} joined`;
	if (event.kind === "leave") return `${who} left`;
	return event.content;
}

export function MessageList({
	events,
	members,
	myPubkey,
	status,
	onReact,
	onReply,
}: {
	events: RoomEvent[];
	members: Record<string, Member>;
	myPubkey: string | null;
	status: "connecting" | "ready" | "error";
	onReact: (targetId: string, emoji: string) => void;
	onReply: (event: RoomEvent) => void;
}) {
	const scroller = useRef<HTMLDivElement | null>(null);
	const nameFor = (key: string) => members[key]?.displayName ?? shortKey(key);
	const now = Date.now();

	const byId = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
	const reactions = useMemo(() => tallyReactions(events), [events]);
	const runs = useMemo(() => groupByAuthor(events), [events]);

	// Keep the newest message in view as the log grows.
	useEffect(() => {
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [events.length]);

	if (events.length === 0) {
		return (
			<Empty
				title={status === "ready" ? "Nothing said yet" : "Loading…"}
				hint="Messages are signed by whoever sent them — human or agent, same room."
			/>
		);
	}

	return (
		<div ref={scroller} className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
			{runs.map((run, index) => {
				if ("system" in run) {
					return (
						<p key={run.system.id} className="px-1 text-center text-xs text-muted-foreground">
							{systemLine(run.system, nameFor(run.system.pubkey))}
						</p>
					);
				}
				const head = run.messages[0]!;
				return (
					<div className="flex gap-3" key={`${run.pubkey}-${head.id}-${index}`}>
						<Avatar
							pubkey={run.pubkey}
							displayName={members[run.pubkey]?.displayName ?? ""}
							kind={run.authorKind}
							you={run.pubkey === myPubkey}
						/>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-2">
								<span className="text-sm font-medium">{nameFor(run.pubkey)}</span>
								{run.authorKind === "agent" ? <Badge tone="neutral">agent</Badge> : null}
								<span
									className="text-xs text-success"
									title={`signed · ${run.pubkey.slice(0, 16)}…`}
								>
									✓ signed
								</span>
								<span className="ml-auto text-xs text-muted-foreground">
									<RelTime at={head.authoredAt} now={now} />
								</span>
							</div>
							<div className="mt-0.5">
								{run.messages.map((event) => (
									<MessageItem
										key={event.id}
										event={event}
										parent={
											replyTargetOf(event) ? byId.get(replyTargetOf(event)!) : undefined
										}
										members={members}
										myPubkey={myPubkey}
										reactions={reactions.get(event.id) ?? []}
										onReact={onReact}
										onReply={onReply}
									/>
								))}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
