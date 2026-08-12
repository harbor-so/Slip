import { describe, expect, it } from "vitest";
import {
	groupByAuthor,
	mergeEvents,
	reactionTargetOf,
	replyTargetOf,
	tallyReactions,
	type RoomEvent,
} from "./events.js";

/**
 * The room's read model is pure, so it can be proven without a browser: the
 * two tag conventions the UI layers on the signed-event primitive (a reaction
 * points at a message, a reply names its parent) and the grouping that turns a
 * flat log into an attributed conversation. These are the parts a rendering bug
 * would hide, so they are tested away from the DOM.
 */

function event(partial: Partial<RoomEvent> & { id: string; seq: number }): RoomEvent {
	return {
		pubkey: "alice",
		authorKind: "human",
		kind: "message",
		content: "",
		sig: "sig",
		authoredAt: new Date(0).toISOString(),
		tags: [],
		...partial,
	};
}

describe("tag conventions", () => {
	it("reads a reply's parent from its tags", () => {
		const reply = event({ id: "b", seq: 2, content: "sure", tags: [["reply", "a"]] });
		expect(replyTargetOf(reply)).toBe("a");
		expect(replyTargetOf(event({ id: "c", seq: 3 }))).toBeUndefined();
	});

	it("reads a reaction's target only for reaction events", () => {
		const reaction = event({ id: "r", seq: 4, kind: "reaction", content: "👍", tags: [["target", "a"]] });
		expect(reactionTargetOf(reaction)).toBe("a");
		// A message carrying a stray target tag is not a reaction.
		expect(reactionTargetOf(event({ id: "m", seq: 5, tags: [["target", "a"]] }))).toBeUndefined();
	});
});

describe("tallyReactions", () => {
	it("folds reactions onto their target and de-dupes by reactor", () => {
		const events: RoomEvent[] = [
			event({ id: "a", seq: 1, content: "ship it" }),
			event({ id: "r1", seq: 2, kind: "reaction", pubkey: "bob", content: "👍", tags: [["target", "a"]] }),
			event({ id: "r2", seq: 3, kind: "reaction", pubkey: "cara", content: "👍", tags: [["target", "a"]] }),
			// bob reacting 👍 twice counts once — it is the set of who, not the count of events.
			event({ id: "r3", seq: 4, kind: "reaction", pubkey: "bob", content: "👍", tags: [["target", "a"]] }),
		];
		const tallies = tallyReactions(events).get("a");
		expect(tallies).toHaveLength(1);
		expect(tallies?.[0]?.emoji).toBe("👍");
		expect(tallies?.[0]?.count).toBe(2);
		expect(tallies?.[0]?.by.sort()).toEqual(["bob", "cara"]);
	});
});

describe("groupByAuthor", () => {
	it("collapses a run by one author and breaks on a new one and on system lines", () => {
		const events: RoomEvent[] = [
			event({ id: "a", seq: 1, pubkey: "alice", content: "one" }),
			event({ id: "b", seq: 2, pubkey: "alice", content: "two" }),
			event({ id: "j", seq: 3, pubkey: "bob", kind: "join", content: "" }),
			event({ id: "c", seq: 4, pubkey: "bob", content: "three" }),
		];
		const grouped = groupByAuthor(events);
		expect(grouped).toHaveLength(3); // alice-run, system(join), bob-run
		const first = grouped[0];
		expect(first && "pubkey" in first && first.pubkey).toBe("alice");
		expect(first && "messages" in first && first.messages).toHaveLength(2);
		expect(grouped[1]).toHaveProperty("system");
	});

	it("never bubbles reactions", () => {
		const events: RoomEvent[] = [
			event({ id: "a", seq: 1, content: "hi" }),
			event({ id: "r", seq: 2, kind: "reaction", content: "👍", tags: [["target", "a"]] }),
		];
		const grouped = groupByAuthor(events);
		const runs = grouped.filter((entry) => "messages" in entry);
		expect(runs).toHaveLength(1);
		expect((runs[0] as { messages: RoomEvent[] }).messages).toHaveLength(1);
	});
});

describe("mergeEvents", () => {
	it("de-dupes by id and sorts by seq", () => {
		const base = [event({ id: "a", seq: 1 }), event({ id: "b", seq: 2 })];
		const merged = mergeEvents(base, [
			event({ id: "b", seq: 2 }), // duplicate
			event({ id: "c", seq: 3 }),
		]);
		expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
	});
});
