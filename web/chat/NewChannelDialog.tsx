"use client";

/**
 * Open a room.
 *
 * Creating needs an identity, because a channel records its creator's pubkey as
 * provenance and seeds them as its first member — so this brings the device key
 * up before it asks the server to make the room, and the creator is a member
 * like anyone else, never an owner. `group` and `task` rooms are key-gated:
 * whoever holds the link is in, which is why the flow ends by dropping you into
 * the room to share it. (A `direct` channel is a fixed roster set at creation,
 * so it is made from a member picker elsewhere, not this open-to-anyone form.)
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@web/design/index.js";
import { ChatClient } from "~/lib/chat-client.js";
import { ensureIdentity } from "~/lib/identity-browser.js";

const KINDS: Array<{ id: "group" | "task"; label: string; hint: string }> = [
	{ id: "group", label: "Group", hint: "An open room; whoever has the link is in." },
	{ id: "task", label: "Task", hint: "A room scoped to a unit of work." },
];

export function NewChannelDialog({ viewerName }: { viewerName: string }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [kind, setKind] = useState<"group" | "task">("group");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function create() {
		const trimmed = title.trim();
		if (!trimmed) return;
		setBusy(true);
		setError(null);
		try {
			const keypair = await ensureIdentity(viewerName);
			const client = new ChatClient({ keypair, displayName: viewerName });
			const channel = await client.createChannel({ title: trimmed, kind });
			router.push(`/c/${channel.key}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	return (
		<>
			<button
				className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
				onClick={() => setOpen(true)}
				type="button"
			>
				New channel
			</button>

			<Dialog open={open} onClose={() => setOpen(false)} title="New channel">
				<div className="space-y-4">
					<div>
						<label className="text-xs text-muted-foreground" htmlFor="channel-title">
							Title
						</label>
						<input
							autoFocus
							className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
							id="channel-title"
							onChange={(event) => setTitle(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void create();
							}}
							placeholder="What is this room about?"
							value={title}
						/>
					</div>

					<div className="grid grid-cols-2 gap-2">
						{KINDS.map((option) => (
							<button
								className={`rounded-md border p-2 text-left text-sm ${
									kind === option.id
										? "border-primary/50 bg-primary/10"
										: "border-border hover:border-primary/30"
								}`}
								key={option.id}
								onClick={() => setKind(option.id)}
								type="button"
							>
								<div className="font-medium">{option.label}</div>
								<div className="mt-0.5 text-xs text-muted-foreground">{option.hint}</div>
							</button>
						))}
					</div>

					<div className="flex items-center gap-3">
						<button
							className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
							disabled={busy || title.trim().length === 0}
							onClick={create}
							type="button"
						>
							{busy ? "Creating…" : "Create"}
						</button>
						{error ? <span className="text-xs text-destructive">{error}</span> : null}
					</div>
				</div>
			</Dialog>
		</>
	);
}
