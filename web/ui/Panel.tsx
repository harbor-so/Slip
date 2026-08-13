"use client";

/**
 * The surfaces: a bordered panel, a section heading, and the two states every
 * live view needs — nothing yet, and not loaded yet. Ported from the tandem
 * shell verbatim so every screen shares one set of surfaces.
 */

import { cx } from "./format.js";

export function Panel({
	children,
	className,
	padded = true,
}: {
	children: React.ReactNode;
	className?: string;
	padded?: boolean;
}) {
	return (
		<div className={cx("rounded-panel border border-line bg-surface", padded && "p-4", className)}>
			{children}
		</div>
	);
}

export function SectionLabel({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<h2 className={cx("text-[11px] font-semibold uppercase tracking-wider text-faint", className)}>
			{children}
		</h2>
	);
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
	return (
		<div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
			<p className="text-sm text-muted">{title}</p>
			{hint ? <p className="max-w-sm text-xs text-faint">{hint}</p> : null}
		</div>
	);
}

export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
	return (
		<div className={cx("space-y-2", className)} aria-hidden>
			{Array.from({ length: rows }, (_, index) => (
				<div
					key={index}
					className="h-12 animate-pulse rounded-md bg-raised"
					style={{ opacity: 1 - index * 0.15 }}
				/>
			))}
		</div>
	);
}

/** Vertical rule used to bracket a block. */
export function Bracket({
	tone,
	children,
}: {
	tone: "quiet" | "hold";
	children: React.ReactNode;
}) {
	return (
		<div
			className={cx(
				"relative pl-4",
				"before:absolute before:left-0 before:top-1 before:bottom-1",
				"before:w-px before:rounded-full",
				tone === "hold" ? "before:bg-hold" : "before:bg-line-strong",
			)}
		>
			{children}
		</div>
	);
}
