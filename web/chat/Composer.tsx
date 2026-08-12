"use client";

/**
 * Where you sign.
 *
 * Every keystroke past a throttle emits an ephemeral `typing` event (fan-out,
 * never stored) so the other side sees a live indicator; pressing send hands the
 * text to the hook, which signs it with the device key before it leaves the tab.
 * The placeholder says so on purpose — "signed with your key before it is sent"
 * is the one fact about this box that is different from every other chat
 * composer, and hiding it would waste the property.
 */

import { useState } from "react";
import { Card } from "@web/design/index.js";
import { shortKey, type Member, type RoomEvent } from "@web/lib/events.js";

export function Composer({
	disabled,
	typing,
	replyTo,
	members,
	error,
	onSend,
	onType,
	onCancelReply,
}: {
	disabled: boolean;
	typing: string | null;
	replyTo: RoomEvent | null;
	members: Record<string, Member>;
	error: string | null;
	onSend: (text: string) => Promise<void>;
	onType: (value: string) => void;
	onCancelReply: () => void;
}) {
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const nameFor = (key: string) => members[key]?.displayName ?? shortKey(key);

	async function submit() {
		const text = body.trim();
		if (!text || busy) return;
		setBusy(true);
		try {
			await onSend(text);
			setBody("");
		} catch {
			// The hook surfaces the error; keep the draft so nothing typed is lost.
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card className="space-y-2">
			{replyTo ? (
				<div className="flex items-center gap-2 rounded-md bg-raised/50 px-2 py-1 text-xs">
					<span className="text-muted-foreground">Replying to</span>
					<span className="font-medium">{nameFor(replyTo.pubkey)}</span>
					<span className="truncate text-muted-foreground">{replyTo.content.slice(0, 60)}</span>
					<button
						className="ml-auto text-muted-foreground hover:text-foreground"
						onClick={onCancelReply}
						type="button"
					>
						✕
					</button>
				</div>
			) : null}

			{typing ? <p className="text-xs text-muted-foreground">{typing} is typing…</p> : null}

			<textarea
				className="min-h-20 w-full rounded-md border border-border bg-background p-3 text-sm"
				disabled={disabled}
				onChange={(event) => {
					setBody(event.target.value);
					onType(event.target.value);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
				}}
				placeholder="Write a message — it will be signed with your key before it is sent."
				value={body}
			/>
			<div className="flex items-center gap-3">
				<button
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
					disabled={disabled || busy || body.trim().length === 0}
					onClick={submit}
					type="button"
				>
					{busy ? "Signing…" : "Send"}
				</button>
				<span className="text-xs text-muted-foreground">⌘↵</span>
				{error ? <span className="text-xs text-destructive">{error}</span> : null}
			</div>
		</Card>
	);
}
