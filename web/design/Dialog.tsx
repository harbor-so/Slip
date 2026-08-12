"use client";

/**
 * A minimal modal, hand-rolled on purpose.
 *
 * `src/components/ui.tsx` says the dashboard skips shadcn/Radix until it grows
 * "real interaction — dialogs, menus, focus traps". A create-channel form and an
 * identity panel are that moment, but one modal does not earn Radix's weight, so
 * this is the smallest thing that behaves: a backdrop that closes on click,
 * Escape to dismiss, and a body scroll-lock while open. If the frontend grows
 * menus and focus traps too, that is when to take shadcn — not for this.
 */

import { useEffect } from "react";
import { cn } from "~/components/ui.js";

export function Dialog({
	open,
	onClose,
	title,
	children,
	className,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
	className?: string;
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKey);
			document.body.style.overflow = previous;
		};
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
			onClick={onClose}
			role="presentation"
		>
			<div
				aria-label={title}
				aria-modal
				className={cn(
					"w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl",
					className,
				)}
				onClick={(event) => event.stopPropagation()}
				role="dialog"
			>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-sm font-semibold">{title}</h2>
					<button
						aria-label="Close"
						className="text-muted-foreground hover:text-foreground"
						onClick={onClose}
						type="button"
					>
						✕
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
