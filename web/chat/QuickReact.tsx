"use client";

/**
 * The small set of one-click reactions.
 *
 * A reaction is a full signed event, so it is not free — a picker with a
 * thousand emoji would be a thousand ways to spend a signature on noise. These
 * six cover acknowledge / agree / celebrate / seen / done / disagree, which is
 * the whole vocabulary a work room actually uses, and anything beyond them is a
 * message. The set is deliberately fixed for that reason, not a placeholder for
 * a full picker.
 */

export const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀", "✅", "🚀"] as const;

export function QuickReact({ onPick }: { onPick: (emoji: string) => void }) {
	return (
		<div className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-sm">
			{QUICK_REACTIONS.map((emoji) => (
				<button
					className="rounded px-1 py-0.5 text-sm hover:bg-raised"
					key={emoji}
					onClick={() => onPick(emoji)}
					type="button"
				>
					{emoji}
				</button>
			))}
		</div>
	);
}
