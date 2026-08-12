/**
 * The shapes the room UI moves, and the pure helpers that read them.
 *
 * These mirror what `GET /api/channels/[key]/events` returns — the server's
 * `ChatEvent` row projected for the wire — plus the two conventions the UI layers
 * on top of the primitive without the server needing to know: a *reaction* is a
 * signed `reaction` event whose content is the emoji and whose tags point at the
 * message it decorates (`["target", <eventId>]`), and a *reply* is a `message`
 * whose tags name its parent (`["reply", <eventId>]`). Both ride the existing
 * `tags: string[][]` field, so nothing new is signed and nothing new is stored.
 *
 * Everything here is pure so it can be unit-tested without a browser (see the
 * verification plan) — the React layer owns all the effects.
 */

/** One event as the events endpoint returns it. */
export interface RoomEvent {
	id: string;
	pubkey: string;
	authorKind: string;
	kind: string;
	seq: number;
	content: string;
	sig: string | null;
	authoredAt: string;
	tags?: string[][];
}

/** A channel member, as the events payload lists them. */
export interface Member {
	pubkey: string;
	displayName: string;
	kind: string;
	/** The member's read cursor, when the server reports it — drives unread counts. */
	lastSeenSeq?: number;
}

/** The tag conventions the UI layers onto the signed-event primitive. */
export const REPLY_TAG = "reply";
export const REACTION_TARGET_TAG = "target";

/** Kinds that render as chat bubbles rather than a system line. */
export function isSaid(event: Pick<RoomEvent, "kind">): boolean {
	return event.kind === "message";
}

/** Kinds that render as a muted, centred system line ("X joined"). */
export function isSystemLine(event: Pick<RoomEvent, "kind">): boolean {
	return (
		event.kind === "join"
		|| event.kind === "leave"
		|| event.kind === "system"
		|| event.kind === "channel_create"
	);
}

/** The first value of the first tag with this name, if any. */
export function firstTag(event: Pick<RoomEvent, "tags">, name: string): string | undefined {
	const hit = event.tags?.find((tag) => tag[0] === name);
	return hit?.[1];
}

/** The event id a message is replying to, if it is a reply. */
export function replyTargetOf(event: Pick<RoomEvent, "tags">): string | undefined {
	return firstTag(event, REPLY_TAG);
}

/** The event id a reaction decorates, if it is a reaction. */
export function reactionTargetOf(event: RoomEvent): string | undefined {
	return event.kind === "reaction" ? firstTag(event, REACTION_TARGET_TAG) : undefined;
}

export interface ReactionTally {
	emoji: string;
	count: number;
	/** Pubkeys who reacted with this emoji — lets the UI show "you reacted". */
	by: string[];
}

/**
 * Fold every reaction event in a channel into `targetId → emoji → who`.
 *
 * Reactions are ordinary events in the same log, so the room already has them;
 * this just indexes them by the message they point at. A pubkey reacting twice
 * with the same emoji counts once — the set of who, not the count of events.
 */
export function tallyReactions(events: RoomEvent[]): Map<string, ReactionTally[]> {
	const byTarget = new Map<string, Map<string, Set<string>>>();
	for (const event of events) {
		const target = reactionTargetOf(event);
		if (!target || !event.content) continue;
		const emojis = byTarget.get(target) ?? new Map<string, Set<string>>();
		const who = emojis.get(event.content) ?? new Set<string>();
		who.add(event.pubkey);
		emojis.set(event.content, who);
		byTarget.set(target, emojis);
	}

	const out = new Map<string, ReactionTally[]>();
	for (const [target, emojis] of byTarget) {
		const tallies: ReactionTally[] = [];
		for (const [emoji, who] of emojis) {
			tallies.push({ emoji, count: who.size, by: [...who] });
		}
		out.set(target, tallies);
	}
	return out;
}

/**
 * Group consecutive events by the same author into visual runs.
 *
 * Slack-style: a person who says three things in a row gets one name header and
 * three lines, not three headers. A run breaks on a new author or a system line.
 * System lines and reactions are dropped — they render on their own, not as
 * bubbles — so a run only ever contains `message` events.
 */
export interface AuthorRun {
	pubkey: string;
	authorKind: string;
	messages: RoomEvent[];
}

export function groupByAuthor(events: RoomEvent[]): Array<AuthorRun | { system: RoomEvent }> {
	const out: Array<AuthorRun | { system: RoomEvent }> = [];
	for (const event of events) {
		if (isSystemLine(event)) {
			out.push({ system: event });
			continue;
		}
		if (!isSaid(event)) continue; // reactions/typing never bubble
		const last = out[out.length - 1];
		if (last && "pubkey" in last && last.pubkey === event.pubkey) {
			last.messages.push(event);
		} else {
			out.push({ pubkey: event.pubkey, authorKind: event.authorKind, messages: [event] });
		}
	}
	return out;
}

/** Merge a batch of events into an existing list, de-duped by id and sorted by seq. */
export function mergeEvents(prev: RoomEvent[], incoming: RoomEvent[]): RoomEvent[] {
	if (incoming.length === 0) return prev;
	const seen = new Set(prev.map((event) => event.id));
	const merged = [...prev];
	for (const event of incoming) if (!seen.has(event.id)) merged.push(event);
	merged.sort((a, b) => a.seq - b.seq);
	return merged;
}

/** A short, human-legible stand-in for a pubkey ("a1b2c3d4…"). */
export function shortKey(pubkey: string): string {
	return `${pubkey.slice(0, 8)}…`;
}
