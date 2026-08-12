"use client";

/**
 * The live room, as a hook.
 *
 * This is `src/app/c/[key]/room.tsx`'s loop lifted out of the view so the
 * polished UI can be built on top of it without touching the mechanics: bring
 * this device's key up, register and join, paint history from the events
 * endpoint, then keep current from the channel's SSE stream — where a durable
 * event announces only a new `seq` and we pull exactly what is past our cursor,
 * while typing/presence arrive inline and never persist. Sending signs locally
 * with the non-extractable key before anything leaves the tab; the server never
 * holds the key and never stamps authorship, which is the entire point of doing
 * this in the client.
 *
 * On top of the primitive it adds the two tag conventions the UI needs —
 * `react()` posts a signed `reaction` pointing at a message, `reply` rides a tag
 * on an ordinary message — neither of which the server has to know about.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatClient, type ChannelRef } from "~/lib/chat-client.js";
import { ensureIdentity } from "~/lib/identity-browser.js";
import { mergeEvents, REACTION_TARGET_TAG, REPLY_TAG, type Member, type RoomEvent } from "@web/lib/events.js";

export type ChannelStatus = "connecting" | "ready" | "error";

export interface UseChannel {
	pubkey: string | null;
	events: RoomEvent[];
	members: Record<string, Member>;
	status: ChannelStatus;
	live: boolean;
	typing: string | null;
	error: string | null;
	send: (content: string, replyTo?: string) => Promise<void>;
	react: (targetId: string, emoji: string) => Promise<void>;
	signalTyping: () => void;
}

export function useChannel(channelKey: string, channelId: string, viewerName: string): UseChannel {
	const clientRef = useRef<ChatClient | null>(null);
	const cursorRef = useRef(0);
	const channelRef = useRef<ChannelRef>({ key: channelKey, id: channelId });

	const [pubkey, setPubkey] = useState<string | null>(null);
	const [events, setEvents] = useState<RoomEvent[]>([]);
	const [members, setMembers] = useState<Record<string, Member>>({});
	const [status, setStatus] = useState<ChannelStatus>("connecting");
	const [live, setLive] = useState(false);
	const [typing, setTyping] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const applyPayload = useCallback((data: { members?: Member[]; events?: RoomEvent[] }) => {
		if (data.members) {
			setMembers((prev) => {
				const next = { ...prev };
				for (const member of data.members!) next[member.pubkey] = member;
				return next;
			});
		}
		if (data.events && data.events.length > 0) {
			setEvents((prev) => mergeEvents(prev, data.events!));
			cursorRef.current = Math.max(cursorRef.current, ...data.events.map((event) => event.seq));
		}
	}, []);

	const loadSince = useCallback(
		async (since: number) => {
			const key = pubkey ?? clientRef.current?.pubkey ?? "";
			const params = new URLSearchParams({ as: key });
			if (since > 0) params.set("since", String(since));
			const res = await fetch(`/api/channels/${channelKey}/events?${params}`, {
				credentials: "include",
			});
			if (res.ok) applyPayload(await res.json());
		},
		[channelKey, pubkey, applyPayload],
	);

	// Bring the identity up, join, paint, and subscribe — once per channel.
	useEffect(() => {
		let source: EventSource | null = null;
		let cancelled = false;

		(async () => {
			try {
				const keypair = await ensureIdentity(viewerName);
				if (cancelled) return;
				const client = new ChatClient({ keypair, displayName: viewerName });
				clientRef.current = client;
				setPubkey(keypair.publicKeyHex);
				await client.join(channelKey);

				const params = new URLSearchParams({ as: keypair.publicKeyHex });
				const res = await fetch(`/api/channels/${channelKey}/events?${params}`, {
					credentials: "include",
				});
				if (res.ok) applyPayload(await res.json());
				setStatus("ready");

				source = new EventSource(`/api/channels/${channelKey}/stream?as=${keypair.publicKeyHex}`, {
					withCredentials: true,
				});
				source.addEventListener("ready", () => setLive(true));
				source.onerror = () => setLive(false);
				source.addEventListener("event", (message) => {
					const change = JSON.parse((message as MessageEvent).data) as {
						kind: string;
						seq?: number;
						actor?: { pubkey: string; displayName: string };
					};
					if (change.kind === "typing") {
						if (change.actor && change.actor.pubkey !== keypair.publicKeyHex) {
							setTyping(change.actor.displayName);
							window.setTimeout(() => setTyping(null), 3000);
						}
						return;
					}
					// Any durable event: pull exactly what is past our cursor.
					void loadSince(cursorRef.current);
				});
			} catch (cause) {
				if (!cancelled) {
					setStatus("error");
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}
		})();

		return () => {
			cancelled = true;
			source?.close();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [channelKey]);

	const send = useCallback(
		async (content: string, replyTo?: string) => {
			const client = clientRef.current;
			const text = content.trim();
			if (!client || !text) return;
			setError(null);
			try {
				const tags = replyTo ? [[REPLY_TAG, replyTo]] : [];
				await client.send(channelRef.current, text, "message", tags);
				await loadSince(cursorRef.current);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				throw cause;
			}
		},
		[loadSince],
	);

	const react = useCallback(
		async (targetId: string, emoji: string) => {
			const client = clientRef.current;
			if (!client || !emoji) return;
			try {
				await client.send(channelRef.current, emoji, "reaction", [[REACTION_TARGET_TAG, targetId]]);
				await loadSince(cursorRef.current);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[loadSince],
	);

	const lastTyped = useRef(0);
	const signalTyping = useCallback(() => {
		const now = Date.now();
		// Throttle: one typing signal every couple of seconds is enough to render.
		if (clientRef.current && now - lastTyped.current > 2000) {
			lastTyped.current = now;
			void clientRef.current.send(channelRef.current, "", "typing").catch(() => {});
		}
	}, []);

	return { pubkey, events, members, status, live, typing, error, send, react, signalTyping };
}
