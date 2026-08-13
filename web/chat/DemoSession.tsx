"use client";

/**
 * The session/chat view, recreated from the reference demo — the multiplayer
 * transcript after a goal opens a session. A live chat between the people in the
 * room and the agent: user turns are small bordered bubbles, agent turns are
 * plain and full-width so their artifacts can breathe, system turns are a
 * centered hairline. Member rail on the right, working composer at the bottom.
 */

import { Anchor, ArrowLeft, ArrowUp, Network, Paperclip, Users } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { cn } from "~/components/ui.js";

type Person = { id: string; name: string; initials: string; color: string; role: string };

const PEOPLE: Record<string, Person> = {
	priya: { id: "priya", name: "Priya Shah", initials: "PS", color: "#8b5cf6", role: "Account Executive" },
	maya: { id: "maya", name: "Maya Chen", initials: "MC", color: "#e8825a", role: "Product Manager" },
	dev: { id: "dev", name: "Dev Patel", initials: "DP", color: "#6366f1", role: "Engineer · projects-api" },
};

type Turn =
	| { speaker: "system"; body: ReactNode }
	| { speaker: "user"; who: string; at: string; body: ReactNode }
	| { speaker: "agent"; at: string; body: ReactNode };

const TRANSCRIPT: Turn[] = [
	{ speaker: "system", body: "Opened by Priya Shah · from a Northwind sales call" },
	{
		speaker: "agent",
		at: "9:02",
		body: (
			<div>
				<p className="text-sm">
					Reading the company first — boards live in <code>acme/web</code>, the board API in{" "}
					<code>projects-api</code> (Dev Patel owns it), and public read access has to skip{" "}
					<code>auth-service</code> entirely.
				</p>
				<div className="mt-2 max-w-2xl rounded-xl border border-border bg-muted/20 px-3 py-2.5">
					<p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						<Network className="size-3.5" />
						Read the company · board sharing
					</p>
					<ul className="mt-1.5 space-y-1 text-xs">
						<li>
							<span className="text-muted-foreground">service</span> <span>projects-api</span>
							<span className="ml-2 font-mono text-[11px] text-muted-foreground">
								owned by Dev Patel · governs board reads
							</span>
						</li>
						<li>
							<span className="text-muted-foreground">doc</span> <span>ADR-014 public access</span>
							<span className="ml-2 font-mono text-[11px] text-muted-foreground">
								notion · no-account reads allowed via signed token
							</span>
						</li>
					</ul>
				</div>
			</div>
		),
	},
	{
		speaker: "agent",
		at: "9:03",
		body: (
			<p className="max-w-2xl text-sm">
				Plan: a signed, revocable share token → a read-only board route that resolves without a
				session. Scoped to one board, view-only, no account required.
			</p>
		),
	},
	{
		speaker: "user",
		who: "priya",
		at: "9:05",
		body: "View-only is the whole ask — Northwind's client can't have edit. And it has to work without them creating an account.",
	},
	{
		speaker: "agent",
		at: "9:06",
		body: (
			<p className="max-w-2xl text-sm">
				Understood — no account, no write. The share link renders a read-only board; every edit
				path stays gated behind the existing session check, so the token can only ever read.
			</p>
		),
	},
	{
		speaker: "user",
		who: "maya",
		at: "9:08",
		body: "Loop in Dev on the projects-api change before you open the PR.",
	},
	{
		speaker: "agent",
		at: "9:09",
		body: (
			<div>
				<p className="max-w-2xl text-sm">
					Added Dev Patel — he owns <code>projects-api</code>. Draft PR opened with the share-token
					model and the public board route; requested his review.
				</p>
				<a
					href="#"
					className="mt-2 inline-flex max-w-md items-center gap-2 rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs hover:border-border/80"
				>
					<span className="flex size-5 items-center justify-center rounded bg-primary/15 font-mono text-[10px] text-primary">
						PR
					</span>
					<span className="truncate">#482 · Public read-only board share links</span>
					<span className="ml-auto shrink-0 text-muted-foreground">3 files</span>
				</a>
			</div>
		),
	},
	{ speaker: "system", body: "PR #482 opened · awaiting review from Dev Patel" },
];

export function DemoSession() {
	const [draft, setDraft] = useState("");

	return (
		<div className="flex min-h-[85vh]">
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-6 backdrop-blur">
					<Link
						href="/demo"
						aria-label="Back"
						className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					>
						<ArrowLeft className="size-4" />
					</Link>
					<h1 className="min-w-0 max-w-[26rem] truncate font-montreal-medium text-xl tracking-tight">
						Public read-only board share links
					</h1>
					<span className="hidden shrink-0 font-mono text-sm text-muted-foreground sm:inline">#147</span>
					<span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
						<span className="size-1.5 animate-pulse rounded-full bg-primary" />
						running
					</span>
					<span className="ml-auto inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
						<Users className="size-3" />
						Multiplayer
					</span>
				</header>

				<div className="flex-1 pb-2">
					{TRANSCRIPT.map((turn, index) => {
						const prev = TRANSCRIPT[index - 1];
						const sameSpeaker =
							prev &&
							prev.speaker === turn.speaker &&
							(turn.speaker !== "user" || (prev.speaker === "user" && prev.who === turn.who));
						return (
							<ChatMessage
								key={index}
								speaker={turn.speaker}
								who={turn.speaker === "user" ? turn.who : undefined}
								at={"at" in turn ? turn.at : undefined}
								showHeader={!sameSpeaker}
							>
								{turn.body}
							</ChatMessage>
						);
					})}
				</div>

				<div className="sticky bottom-0 z-20 border-t border-border bg-background px-6 pt-3 pb-3">
					<form
						className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5 focus-within:border-border/80"
						onSubmit={(event) => {
							event.preventDefault();
							setDraft("");
						}}
					>
						<Paperclip className="size-4 shrink-0 text-muted-foreground" />
						<input
							className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
							onChange={(event) => setDraft(event.target.value)}
							placeholder="Direct this run as Priya…"
							value={draft}
						/>
						<span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
							claude opus 4.5
						</span>
						<button
							aria-label="Send"
							className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
							disabled={!draft.trim()}
							type="submit"
						>
							<ArrowUp className="size-4" />
						</button>
					</form>
				</div>
			</div>

			<aside className="hidden w-64 shrink-0 border-l border-border xl:block">
				<div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
					<span className="font-montreal-medium text-sm">Members</span>
					<span className="ml-auto text-xs text-muted-foreground tabular-nums">4</span>
				</div>
				<div className="py-1">
					<div className="flex items-start gap-2.5 px-3 py-2.5">
						<BotAvatar />
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium">Harbor</p>
							<p className="truncate text-[11px] text-muted-foreground">Agent</p>
						</div>
					</div>
					{[
						{ p: PEOPLE.priya!, why: "owner · opened this session" },
						{ p: PEOPLE.maya!, why: "joined to steer" },
						{ p: PEOPLE.dev!, why: "added by agent — owns projects-api" },
					].map(({ p, why }) => (
						<div className="flex items-start gap-2.5 px-3 py-2.5" key={p.id}>
							<PersonAvatar person={p} />
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium">{p.name}</p>
								<p className="truncate text-[11px] text-muted-foreground">{p.role}</p>
								<p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/60">{why}</p>
							</div>
						</div>
					))}
				</div>
			</aside>
		</div>
	);
}

function ChatMessage({
	speaker,
	who,
	at,
	showHeader = true,
	children,
}: {
	speaker: "user" | "agent" | "system";
	who?: string;
	at?: string;
	showHeader?: boolean;
	children: ReactNode;
}) {
	if (speaker === "system") {
		return (
			<div className="flex items-center gap-3 px-6 py-3 text-xs">
				<span className="h-px flex-1 bg-border" />
				<span className="shrink-0 text-center text-muted-foreground">{children}</span>
				<span className="h-px flex-1 bg-border" />
			</div>
		);
	}

	const isUser = speaker === "user";
	const author = who ? PEOPLE[who] : undefined;

	return (
		<div className={cn("flex gap-3 px-6", showHeader ? "pt-4 pb-1" : "pt-1 pb-1")}>
			<div className="w-6 shrink-0">
				{showHeader ? isUser && author ? <PersonAvatar person={author} /> : <BotAvatar /> : null}
			</div>
			<div className="min-w-0 flex-1">
				{showHeader ? (
					<div className="flex items-baseline gap-2">
						<span className="text-sm font-medium">{isUser ? (author?.name ?? "You") : "Harbor"}</span>
						{at ? <span className="text-xs tabular-nums text-muted-foreground">{at}</span> : null}
					</div>
				) : null}
				<div className={cn("mt-1.5", isUser && "rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-sm")}>
					{children}
				</div>
			</div>
		</div>
	);
}

function PersonAvatar({ person }: { person: Person }) {
	return (
		<span
			className="inline-flex size-6 shrink-0 select-none items-center justify-center rounded-full text-[10px] font-medium text-white"
			style={{ backgroundColor: person.color }}
			title={person.name}
		>
			{person.initials}
		</span>
	);
}

function BotAvatar() {
	return (
		<span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary" title="Harbor">
			<Anchor className="size-3.5" />
		</span>
	);
}
