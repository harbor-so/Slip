"use client";

/**
 * Who is in the room.
 *
 * Membership is the access gate — a name here is a key that passed the check to
 * read and write — so the rail is also the honest answer to "who can see this".
 * Humans and agents are listed together and told apart only by the badge and the
 * avatar shape, which is the membership model made visible: the room does not
 * have a separate class of participant for a bot.
 */

import { Avatar, Badge, SectionLabel } from "@web/design/index.js";
import { shortKey, type Member } from "@web/lib/events.js";

export function MemberRail({
	members,
	myPubkey,
	typing,
}: {
	members: Record<string, Member>;
	myPubkey: string | null;
	typing: string | null;
}) {
	const list = Object.values(members).sort((a, b) => a.displayName.localeCompare(b.displayName));
	const humans = list.filter((member) => member.kind !== "agent").length;
	const agents = list.length - humans;

	return (
		<aside className="w-56 shrink-0 space-y-3">
			<SectionLabel>
				Members ({humans} human{humans === 1 ? "" : "s"}
				{agents > 0 ? `, ${agents} agent${agents === 1 ? "" : "s"}` : ""})
			</SectionLabel>
			<div className="space-y-1.5">
				{list.map((member) => {
					const isYou = member.pubkey === myPubkey;
					const isTyping = typing !== null && member.displayName === typing;
					return (
						<div className="flex items-center gap-2" key={member.pubkey}>
							<Avatar
								pubkey={member.pubkey}
								displayName={member.displayName}
								kind={member.kind}
								size={22}
								you={isYou}
							/>
							<span className="truncate text-sm">
								{member.displayName || shortKey(member.pubkey)}
							</span>
							{isYou ? <span className="text-xs text-muted-foreground">you</span> : null}
							{member.kind === "agent" ? <Badge tone="neutral">agent</Badge> : null}
							{isTyping ? <span className="ml-auto text-xs text-muted-foreground">…</span> : null}
						</div>
					);
				})}
			</div>
		</aside>
	);
}
