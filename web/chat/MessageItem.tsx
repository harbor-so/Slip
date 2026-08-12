"use client";

/**
 * One thing somebody said.
 *
 * The bubble carries the two proofs the whole plane exists to make legible: a
 * `✓ signed` mark (this content was signed by the key attributed to it, verified
 * before it was ever stored) and, for a non-human author, an `agent` badge —
 * because the room treats a human and an agent identically and the only honest
 * way to show that is to attribute both the same and label what each is. On
 * hover it offers the two tag-based actions the primitive supports without
 * knowing about them: react and reply.
 */

import { useState } from "react";
import {
	firstTag,
	reactionTargetOf,
	replyTargetOf,
	shortKey,
	type Member,
	type ReactionTally,
	type RoomEvent,
} from "@web/lib/events.js";
import { QuickReact } from "./QuickReact.js";

export function MessageItem({
	event,
	parent,
	members,
	myPubkey,
	reactions,
	onReact,
	onReply,
}: {
	event: RoomEvent;
	/** The message this one replies to, resolved by the list, if any. */
	parent?: RoomEvent;
	members: Record<string, Member>;
	myPubkey: string | null;
	reactions: ReactionTally[];
	onReact: (targetId: string, emoji: string) => void;
	onReply: (event: RoomEvent) => void;
}) {
	const [picking, setPicking] = useState(false);
	const nameFor = (key: string) => members[key]?.displayName ?? shortKey(key);
	const replyTo = replyTargetOf(event);

	return (
		<div className="group relative rounded-md px-2 py-0.5 hover:bg-raised/40">
			{replyTo ? (
				<div className="mb-0.5 flex items-center gap-1 pl-1 text-xs text-muted-foreground">
					<span className="text-muted-foreground/60">↳</span>
					<span className="font-medium">{parent ? nameFor(parent.pubkey) : "a message"}</span>
					<span className="truncate opacity-80">
						{parent ? parent.content.slice(0, 80) : "(not loaded)"}
					</span>
				</div>
			) : null}

			<p className="whitespace-pre-wrap text-sm leading-relaxed">{event.content}</p>

			{reactions.length > 0 ? (
				<div className="mt-1 flex flex-wrap gap-1">
					{reactions.map((tally) => {
						const mine = myPubkey ? tally.by.includes(myPubkey) : false;
						return (
							<button
								className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${
									mine
										? "border-primary/40 bg-primary/15 text-primary"
										: "border-border bg-raised text-muted-foreground hover:border-primary/30"
								}`}
								key={tally.emoji}
								onClick={() => onReact(event.id, tally.emoji)}
								title={tally.by.map((key) => nameFor(key)).join(", ")}
								type="button"
							>
								<span>{tally.emoji}</span>
								<span className="nums">{tally.count}</span>
							</button>
						);
					})}
				</div>
			) : null}

			{/* Hover actions — react and reply, the two things a tag can carry. */}
			<div className="absolute right-2 top-0 hidden -translate-y-1/2 items-center gap-1 group-hover:flex">
				{picking ? (
					<QuickReact
						onPick={(emoji) => {
							onReact(event.id, emoji);
							setPicking(false);
						}}
					/>
				) : (
					<div className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-sm">
						<button
							className="rounded px-1 py-0.5 text-xs hover:bg-raised"
							onClick={() => setPicking(true)}
							title="React"
							type="button"
						>
							😊
						</button>
						<button
							className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground"
							onClick={() => onReply(event)}
							title="Reply"
							type="button"
						>
							↩
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

/** Whether an event should be rendered by this component at all. */
export function isReaction(event: RoomEvent): boolean {
	return reactionTargetOf(event) !== undefined || (event.kind === "reaction" && !firstTag(event, "target"));
}
