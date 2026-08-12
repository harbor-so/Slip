"use client";

/**
 * Your key, stated plainly.
 *
 * The chat plane's identity is a keypair this browser holds and the server never
 * sees, which has one sharp consequence worth surfacing rather than burying: the
 * key is per-device and has no recovery (CHAT.md, known limitation #1). A new
 * browser is a new person. So the panel shows the public key you are, lets you
 * rename it (idempotent re-register — same key, new label), and offers the one
 * destructive action honestly labelled: forget this key and start fresh.
 */

import { useState } from "react";
import { Dialog } from "@web/design/index.js";
import { resetIdentity } from "~/lib/identity-browser.js";

export function IdentityPanel({
	open,
	onClose,
	pubkey,
	displayName,
	onRename,
}: {
	open: boolean;
	onClose: () => void;
	pubkey: string | null;
	displayName: string;
	onRename: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState(displayName);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);

	async function save() {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		try {
			await onRename(trimmed);
			onClose();
		} finally {
			setBusy(false);
		}
	}

	async function reset() {
		await resetIdentity();
		// A fresh identity only takes effect on reload — the running tab still holds
		// the old key in memory. Reloading is the honest way to become the new one.
		window.location.reload();
	}

	return (
		<Dialog open={open} onClose={onClose} title="Your identity on this device">
			<div className="space-y-4">
				<div>
					<label className="text-xs text-muted-foreground" htmlFor="identity-name">
						Display name
					</label>
					<input
						autoFocus
						className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
						id="identity-name"
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void save();
						}}
						value={name}
					/>
				</div>

				<div>
					<span className="text-xs text-muted-foreground">Public key</span>
					<button
						className="mt-1 block w-full truncate rounded-md border border-border bg-muted/40 px-3 py-1.5 text-left font-mono text-xs hover:border-primary/30"
						onClick={() => {
							if (pubkey) void navigator.clipboard.writeText(pubkey);
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						}}
						title="Click to copy"
						type="button"
					>
						{copied ? "copied" : (pubkey ?? "generating…")}
					</button>
				</div>

				<p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					This key lives only in this browser and never reaches the server. It has no backup
					and no recovery — a different browser is a different person until key portability is
					built.
				</p>

				<div className="flex items-center justify-between gap-2 pt-1">
					{confirmReset ? (
						<div className="flex items-center gap-2 text-xs">
							<span className="text-destructive">Forget this key and start fresh?</span>
							<button
								className="rounded-md bg-destructive px-2 py-1 font-medium text-destructive-foreground"
								onClick={reset}
								type="button"
							>
								Forget
							</button>
							<button
								className="text-muted-foreground hover:text-foreground"
								onClick={() => setConfirmReset(false)}
								type="button"
							>
								Cancel
							</button>
						</div>
					) : (
						<button
							className="text-xs text-muted-foreground hover:text-destructive"
							onClick={() => setConfirmReset(true)}
							type="button"
						>
							Start a new identity
						</button>
					)}
					<button
						className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
						disabled={busy || name.trim().length === 0}
						onClick={save}
						type="button"
					>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</div>
		</Dialog>
	);
}
