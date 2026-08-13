"use client";

/**
 * Status pills, and the mapping from a status to a colour. Ported from the
 * tandem shell. The domain-specific badges there (session/run/instruction)
 * lived against tandem's schema; here the generic `Badge` + `Pulse` carry the
 * vocabulary and each Harbor page maps its own statuses onto a tone.
 *
 * There is one alarm — `hold`. If a second status is ever rendered in the hold
 * colour, the room stops having one alarm.
 */

import { cx } from "./format.js";

export type Tone = "neutral" | "accent" | "good" | "bad" | "hold";

const TONES: Record<Tone, string> = {
	neutral: "bg-raised text-muted border-line",
	accent: "bg-accent-quiet text-accent border-accent/40",
	good: "bg-good/10 text-good border-good/30",
	bad: "bg-bad/10 text-bad border-bad/30",
	hold: "bg-hold-quiet text-hold border-hold/50",
};

export function Badge({
	tone = "neutral",
	children,
	className,
}: {
	tone?: Tone;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cx(
				"inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
				"text-[11px] font-medium leading-4 whitespace-nowrap",
				TONES[tone],
				className,
			)}
		>
			{children}
		</span>
	);
}

/** A dot that breathes. Used only where something is genuinely in progress. */
export function Pulse({ className }: { className?: string }) {
	return (
		<span
			className={cx("inline-block size-1.5 rounded-full bg-current animate-pulse", className)}
		/>
	);
}
