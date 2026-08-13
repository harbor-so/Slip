"use client";

/**
 * The chat screen, literally — tandem's session transcript recreated with a
 * hardcoded Priya conversation. Static demo data on purpose: this is the look,
 * wired to nothing, so we can see it and change it. The live version lives in
 * the real Room; this is the reference screen.
 */

import {
	ArrowLeft,
	CornerDownLeft,
	FileDiff,
	GitBranch,
	Network,
	Terminal,
	Users,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar, Badge, SectionLabel, cx, type UserRef } from "@web/ui/index.js";

// --- the cast ---------------------------------------------------------------

const PEOPLE: Record<string, UserRef & { kind: "human" | "agent"; because: string }> = {
	priya: { id: "priya", name: "Priya Nair", color: "oklch(0.72 0.15 20)", kind: "human", because: "owns src/billing" },
	maya: { id: "maya", name: "Maya Chen", color: "oklch(0.72 0.13 150)", kind: "human", because: "pulled in by Priya" },
	ana: { id: "ana", name: "Ana Duarte", color: "oklch(0.72 0.14 280)", kind: "human", because: "on call for payments" },
	claude: { id: "claude", name: "Claude", color: "oklch(0.72 0.13 40)", kind: "agent", because: "the agent on this run" },
};

type Row =
	| { t: "status"; at: string; text: string }
	| { t: "context"; at: string; query: string; facts: { kind: string; label: string; source: string; why: string }[] }
	| { t: "thinking"; at: string; who: string; text: string }
	| { t: "tool"; at: string; name: string; input: string }
	| { t: "file_edit"; at: string; path: string; additions: number; deletions: number }
	| { t: "reviewers"; at: string; suggestions: { label: string; via: string; path: string }[] }
	| { t: "message"; at: string; who: string; text: string };

const TIMELINE: Row[] = [
	{ t: "status", at: "14:02:11", text: "Run started · refactor the billing charge path" },
	{
		t: "context",
		at: "14:02:12",
		query: "billing service ownership",
		facts: [
			{ kind: "person", label: "Priya Nair", source: "github", why: "owns src/billing (4 files)" },
			{ kind: "service", label: "billing", source: "org-graph", why: "only person attached" },
			{ kind: "doc", label: "ADR-014 payment retries", source: "notion", why: "governs the charge path" },
		],
	},
	{ t: "thinking", at: "14:02:14", who: "claude", text: "charge.ts retries on 5xx but not on network timeouts, and the retry cap is read from an env var with no default. I'll add a bounded retry with jitter and pin the cap." },
	{ t: "tool", at: "14:02:15", name: "read_file", input: "path=src/billing/charge.ts" },
	{ t: "message", at: "14:02:44", who: "priya", text: "Careful — the retry cap has to stay at 3. Anything higher and we double-charge inside the gateway's idempotency window." },
	{ t: "message", at: "14:03:01", who: "claude", text: "Understood. Keeping maxRetries at 3 and gating each attempt on the idempotency key, so a retry can't ever create a second charge." },
	{ t: "file_edit", at: "14:03:20", path: "src/billing/charge.ts", additions: 24, deletions: 6 },
	{ t: "message", at: "14:03:52", who: "maya", text: "Can we emit a metric when we hit the cap? Ana's on call and will want to see retry_exhausted climbing before a customer does." },
	{ t: "message", at: "14:04:07", who: "ana", text: "+1. A counter on retry_exhausted is enough, I'll wire the alert my side." },
	{ t: "tool", at: "14:04:10", name: "edit_file", input: "path=src/billing/metrics.ts  add=counter(retry_exhausted)" },
	{
		t: "reviewers",
		at: "14:04:40",
		suggestions: [
			{ label: "Priya Nair", via: "owns the directory", path: "src/billing" },
			{ label: "Ana Duarte", via: "on call for", path: "payments" },
		],
	},
	{ t: "message", at: "14:04:41", who: "claude", text: "Opened PR #482 — bounded retry with jitter + a retry_exhausted counter. Requested review from Priya and Ana." },
];

const PRESENCE: Record<string, "typing" | "viewing"> = { ana: "typing" };

// --- screen -----------------------------------------------------------------

export function DemoTranscript() {
	const [draft, setDraft] = useState("");
	const [extra, setExtra] = useState<Row[]>([]);
	const rows = [...TIMELINE, ...extra];

	function send() {
		const text = draft.trim();
		if (!text) return;
		setExtra((prev) => [...prev, { t: "message", at: "now", who: "priya", text }]);
		setDraft("");
	}

	return (
		<div className="flex h-[82vh] overflow-hidden rounded-panel border border-line">
			<div className="flex min-w-0 flex-1 flex-col bg-bg">
				<header className="shrink-0 border-b border-line">
					<div className="flex h-14 items-center gap-3 px-4">
						<Link href="/channels" className="rounded-md p-1 text-faint hover:bg-raised hover:text-text" aria-label="Back">
							<ArrowLeft className="size-4" />
						</Link>
						<span className="nums text-xs text-faint">#482</span>
						<h1 className="min-w-0 flex-1 truncate text-sm font-semibold">Refactor the billing charge path</h1>
						<div className="flex shrink-0 items-center gap-2">
							<Badge tone="neutral">
								<GitBranch className="size-3" />
								supervised
							</Badge>
							<span className="nums text-[11px] text-faint">18.2k tok · $0.14</span>
							<Badge tone="accent">running</Badge>
						</div>
					</div>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
					<div className="mx-auto max-w-3xl">
						{rows.map((row, index) => (
							<TranscriptRow key={index} row={row} />
						))}
					</div>
				</div>

				<div className="shrink-0 border-t border-line bg-surface px-4 py-3">
					<div className={cx("rounded-panel border bg-bg/60", draft.trim() ? "border-line-strong" : "border-line")}>
						<textarea
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									send();
								}
							}}
							rows={1}
							placeholder="Steer it while it works…"
							className="w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed placeholder:text-faint focus:outline-none"
						/>
						<div className="flex items-center gap-2 px-3 pb-2">
							<p className="min-w-0 flex-1 truncate text-[11px] text-faint">
								A run is going. This lands on the next step, or holds if it cuts across something already in force.
							</p>
							<button
								onClick={send}
								disabled={!draft.trim()}
								type="button"
								className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-bg hover:brightness-110 disabled:opacity-40"
							>
								<CornerDownLeft className="size-3.5" />
								Send
							</button>
						</div>
					</div>
				</div>
			</div>

			<aside className="flex w-64 shrink-0 flex-col border-l border-line bg-surface">
				<div className="flex h-14 shrink-0 items-center px-4">
					<SectionLabel>In the room · 4 of 4</SectionLabel>
				</div>
				<ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
					{Object.values(PEOPLE).map((person) => {
						const state = PRESENCE[person.id] ?? "viewing";
						return (
							<li key={person.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
								<Avatar user={person} size="sm" presence={state} className="mt-0.5" />
								<div className="min-w-0 flex-1">
									<p className="flex items-baseline gap-1.5 text-xs">
										<span className="truncate font-medium text-text">{person.name}</span>
										{person.kind === "agent" ? <span className="shrink-0 text-[10px] text-accent">agent</span> : null}
									</p>
									<p className="truncate text-[11px] text-faint">
										{state === "typing" ? "typing…" : person.because}
									</p>
								</div>
							</li>
						);
					})}
				</ul>
			</aside>
		</div>
	);
}

function TranscriptRow({ row }: { row: Row }) {
	switch (row.t) {
		case "status":
			return (
				<Line at={row.at}>
					<span className="text-xs text-faint">{row.text}</span>
				</Line>
			);
		case "thinking":
			return (
				<Line at={row.at}>
					<p className="max-w-2xl text-xs italic leading-relaxed text-faint">{row.text}</p>
				</Line>
			);
		case "tool":
			return (
				<Line at={row.at}>
					<div className="max-w-2xl rounded-md border border-line bg-raised/50 px-2.5 py-1.5">
						<div className="flex items-center gap-2">
							<Terminal className="size-3 shrink-0 text-faint" />
							<span className="font-mono text-xs text-muted">{row.name}</span>
						</div>
						<pre className="mt-1 overflow-x-auto font-mono text-[11px] leading-relaxed text-faint">{row.input}</pre>
					</div>
				</Line>
			);
		case "file_edit":
			return (
				<Line at={row.at}>
					<span className="flex items-center gap-2 font-mono text-xs">
						<FileDiff className="size-3 text-faint" />
						<span className="text-muted">{row.path}</span>
						<span className="nums text-good">+{row.additions}</span>
						<span className="nums text-bad">−{row.deletions}</span>
					</span>
				</Line>
			);
		case "context":
			return (
				<Line at={row.at}>
					<div className="max-w-2xl rounded-panel border border-line bg-raised/50 px-3 py-2.5">
						<p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
							<Network className="size-3.5" />
							Read the company · {row.query}
						</p>
						<ul className="mt-1.5 space-y-1">
							{row.facts.map((fact) => (
								<li key={fact.label} className="text-xs">
									<span className="text-faint">{fact.kind}</span> <span className="text-text">{fact.label}</span>
									<span className="ml-2 font-mono text-[11px] text-faint">{fact.source} · {fact.why}</span>
								</li>
							))}
						</ul>
					</div>
				</Line>
			);
		case "reviewers":
			return (
				<Line at={row.at}>
					<div className="max-w-2xl rounded-panel border border-line bg-raised/50 px-3 py-2.5">
						<p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
							<Users className="size-3.5" />
							Suggested reviewers
						</p>
						<ul className="mt-1.5 space-y-1">
							{row.suggestions.map((s) => (
								<li key={s.label} className="flex items-baseline gap-2 text-xs">
									<span className="text-text">{s.label}</span>
									<span className="min-w-0 truncate font-mono text-[11px] text-faint">{s.via} {s.path}</span>
								</li>
							))}
						</ul>
					</div>
				</Line>
			);
		case "message": {
			const person = PEOPLE[row.who]!;
			return (
				<Line at={row.at}>
					<div className="flex items-baseline gap-2">
						<span className="text-sm font-medium text-text">{person.name}</span>
						{person.kind === "agent" ? <Badge tone="accent">agent</Badge> : null}
						<span className="text-[10px] text-good" title="signed">✓ signed</span>
					</div>
					<p className="mt-0.5 max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-text">{row.text}</p>
				</Line>
			);
		}
	}
}

function Line({ at, children }: { at: string; children: React.ReactNode }) {
	return (
		<div className="animate-in flex gap-3 px-1 py-1">
			<span className="nums w-14 shrink-0 pt-0.5 text-right text-[10px] text-faint/70">{at}</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
