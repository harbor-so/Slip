/**
 * A face for a public key.
 *
 * An identity here is a 64-character hex string; nobody recognises one by
 * reading it. So we derive a stable colour and a two-character monogram from the
 * key itself — same key, same face, every session, with no lookup and no stored
 * avatar. An agent gets a square-ish ring and a human a round one, so the one
 * distinction the room *does* make (who is a person) is visible at a glance
 * without reading a badge.
 */

import { cn } from "~/components/ui.js";

/** A hue in [0,360) derived from the key — deterministic, no crypto needed. */
function hueOf(pubkey: string): number {
	let hash = 0;
	for (let index = 0; index < pubkey.length; index += 1) {
		hash = (hash * 31 + pubkey.charCodeAt(index)) % 360;
	}
	return hash;
}

function monogram(displayName: string, pubkey: string): string {
	const trimmed = displayName.trim();
	if (trimmed) {
		const parts = trimmed.split(/\s+/);
		const first = parts[0]?.[0] ?? "";
		const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
		return (first + second).toUpperCase() || trimmed.slice(0, 2).toUpperCase();
	}
	return pubkey.slice(0, 2).toUpperCase();
}

export function Avatar({
	pubkey,
	displayName = "",
	kind = "human",
	size = 28,
	you = false,
}: {
	pubkey: string;
	displayName?: string;
	kind?: string;
	size?: number;
	/** Ring this avatar in the primary colour to mark "this is you". */
	you?: boolean;
}) {
	const hue = hueOf(pubkey);
	const isAgent = kind === "agent";
	return (
		<span
			aria-hidden
			className={cn(
				"inline-flex shrink-0 items-center justify-center font-medium text-white",
				isAgent ? "rounded-md" : "rounded-full",
				you && "ring-2 ring-primary ring-offset-1 ring-offset-background",
			)}
			style={{
				width: size,
				height: size,
				fontSize: Math.round(size * 0.4),
				backgroundColor: `oklch(0.62 0.13 ${hue})`,
			}}
			title={`${displayName || pubkey.slice(0, 12)} · ${kind}`}
		>
			{monogram(displayName, pubkey)}
		</span>
	);
}
