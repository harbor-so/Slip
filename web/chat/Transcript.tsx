"use client";

/**
 * The transcript — tandem's session timeline, recreated on Harbor's signed
 * events.
 *
 * One column, one timeline, timestamps in a fixed gutter so a reader scanning
 * for a name does not have to track a ragged left edge. Every row is a real
 * signed event from the channel. Ordinary chat renders as a message line; a few
 * richer rows (the agent thinking, a tool call, "read the company", suggested
 * reviewers) are seeded events that carry a `["t", <kind>]` tag and a JSON body,
 * which is how the Priya demo shows the org-graph reasoning the way the tandem
 * transcript does — without inventing new server-side event kinds.
 */

import {
	AlertTriangle,
	Box,
	FileDiff,
	Network,
	Scissors,
	Terminal,
	Users,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge, Empty, clockTime, cx } from "@web/ui/index.js";
import { firstTag, shortKey, type Member, type RoomEvent } from "@web/lib/events.js";

function parsePayload(event: RoomEvent): { kind: string; data: Record<string, unknown> } {
	const kind = firstTag(event, "t") ?? (event.kind === "message" ? "message" : event.kind);
	if (kind === "message" || event.kind !== "message") return { kind, data: {} };
	try {
		return { kind, data: JSON.parse(event.content) as Record<string, unknown> };
	} catch {
		return { kind: "message", data: {} };
	}
}

export function Transcript({
	events,
	members,
	myPubkey,
	status,
}: {
	events: RoomEvent[];
	members: Record<string, Member>;
	myPubkey: string | null;
	status: "connecting" | "ready" | "error";
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const nameFor = (key: string) => members[key]?.displayName ?? shortKey(key);

	useEffect(() => {
		const element = scroller.current;
		if (element && atBottom.current) element.scrollTop = element.scrollHeight;
	}, [events.length]);

	function onScroll() {
		const element = scroller.current;
		if (!element) return;
		atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
	}

	const shown = events.filter((event) => event.kind === "message");

	if (shown.length === 0) {
		return (
			<div className="min-h-0 flex-1 overflow-y-auto">
				<Empty
					title={status === "ready" ? "Nothing has happened yet." : "Loading…"}
					hint="Send the first message below. Anyone in the room can send one at any time — human or agent, same room."
				/>
			</div>
		);
	}

	return (
		<div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
			<div className="mx-auto max-w-3xl">
				{shown.map((event) => (
					<TranscriptRow key={event.id} event={event} name={nameFor(event.pubkey)} you={event.pubkey === myPubkey} />
				))}
			</div>
		</div>
	);
}

function TranscriptRow({ event, name, you }: { event: RoomEvent; name: string; you: boolean }) {
	const at = new Date(event.authoredAt).getTime();
	const { kind, data } = parsePayload(event);
	const isAgent = event.authorKind === "agent";

	switch (kind) {
		case "thinking":
			return (
				<Line at={at}>
					<p className="max-w-2xl text-xs italic leading-relaxed text-faint">{event.content}</p>
				</Line>
			);

		case "status":
			return (
				<Line at={at}>
					<span className="text-xs text-faint">{event.content}</span>
				</Line>
			);

		case "notice":
			return (
				<Line at={at}>
					<span className="flex items-center gap-1.5 text-xs text-faint">
						<Scissors className="size-3" />
						{event.content}
					</span>
				</Line>
			);

		case "sandbox":
			return (
				<Line at={at}>
					<span className="flex items-center gap-1.5 text-xs text-faint">
						<Box className="size-3" />
						{event.content}
					</span>
				</Line>
			);

		case "tool":
			return (
				<Line at={at}>
					<div className="max-w-2xl rounded-md border border-line bg-raised/50 px-2.5 py-1.5">
						<div className="flex items-center gap-2">
							<Terminal className="size-3 shrink-0 text-faint" />
							<span className="font-mono text-xs text-muted">{String(data.name ?? "tool")}</span>
						</div>
						<pre className="mt-1 overflow-x-auto font-mono text-[11px] leading-relaxed text-faint">
							{String(data.input ?? "")}
						</pre>
					</div>
				</Line>
			);

		case "file_edit":
			return (
				<Line at={at}>
					<span className="flex items-center gap-2 font-mono text-xs">
						<FileDiff className="size-3 text-faint" />
						<span className="text-muted">{String(data.path ?? "")}</span>
						<span className="nums text-good">+{Number(data.additions ?? 0)}</span>
						<span className="nums text-bad">−{Number(data.deletions ?? 0)}</span>
					</span>
				</Line>
			);

		case "context":
			return (
				<Line at={at}>
					<div className="max-w-2xl rounded-panel border border-line bg-raised/50 px-3 py-2.5">
						<p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
							<Network className="size-3.5" />
							Read the company · {String(data.query ?? "")}
						</p>
						<ul className="mt-1.5 space-y-1">
							{(data.facts as Array<Record<string, string>> | undefined)?.map((fact, index) => (
								<li key={index} className="text-xs">
									<span className="text-faint">{fact.kind}</span>{" "}
									<span className="text-text">{fact.label}</span>
									<span className="ml-2 font-mono text-[11px] text-faint">
										{fact.source} · {fact.why}
									</span>
								</li>
							))}
						</ul>
					</div>
				</Line>
			);

		case "reviewers":
			return (
				<Line at={at}>
					<div className="max-w-2xl rounded-panel border border-line bg-raised/50 px-3 py-2.5">
						<p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
							<Users className="size-3.5" />
							Suggested reviewers
						</p>
						<ul className="mt-1.5 space-y-1">
							{(data.suggestions as Array<Record<string, string>> | undefined)?.map((s, index) => (
								<li key={index} className="flex items-baseline gap-2 text-xs">
									<span className="text-text">{s.label}</span>
									<span className="min-w-0 truncate font-mono text-[11px] text-faint">
										{s.via} {s.path}
									</span>
								</li>
							))}
						</ul>
					</div>
				</Line>
			);

		case "error":
			return (
				<Line at={at}>
					<p className="flex max-w-2xl items-start gap-2 text-xs text-bad">
						<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
						{event.content}
					</p>
				</Line>
			);

		default:
			return (
				<Line at={at}>
					<div className="flex items-baseline gap-2">
						<span className="text-sm font-medium text-text">{name}</span>
						{isAgent ? <Badge tone="accent">agent</Badge> : null}
						{you ? <span className="text-[10px] text-faint">you</span> : null}
						<span className="text-[10px] text-good" title="signed">
							✓ signed
						</span>
					</div>
					<p className="mt-0.5 max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-text">
						{event.content}
					</p>
				</Line>
			);
	}
}

/** Timestamps sit in a fixed gutter rather than inline, so the transcript stays scannable. */
function Line({ at, children }: { at: number; children: React.ReactNode }) {
	return (
		<div className={cx("flex gap-3 px-1 py-1")}>
			<span className="nums w-14 shrink-0 pt-0.5 text-right text-[10px] text-faint/70">
				{clockTime(at)}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
