"use client";

/**
 * The top titlebar — recreated from the reference demo's DemoHeader. Org chip on
 * the left, a search field in the middle, notifications and the signed-in
 * identity on the right. Static/presentational: it is chrome, not a control
 * surface, so nothing here is wired to a backend.
 */

import { ChevronsUpDown, Inbox, Search } from "lucide-react";

export function TopHeader({
	orgName,
	viewer,
}: {
	orgName: string;
	viewer: { name: string; initials: string; color: string };
}) {
	return (
		<header className="z-20 grid h-11 w-full shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-x-4 border-b border-border bg-sidebar px-4 backdrop-blur-xl">
			<div className="flex min-w-0 items-center">
				<button
					className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium hover:bg-hover-muted"
					type="button"
				>
					<span className="flex size-5 items-center justify-center rounded bg-primary font-montreal-bold text-[10px] text-primary-foreground">
						{orgName.charAt(0).toUpperCase()}
					</span>
					<span className="max-w-[120px] truncate">{orgName}</span>
					<ChevronsUpDown className="size-3 shrink-0 opacity-50" />
				</button>
			</div>

			<div className="hidden md:block">
				<div className="relative w-48 lg:w-72">
					<Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						className="h-7 w-full cursor-pointer rounded-md border border-border bg-card pr-12 pl-9 text-xs outline-none placeholder:text-muted-foreground"
						placeholder="Search…"
						readOnly
					/>
					<kbd className="absolute top-1/2 right-2 hidden h-4 -translate-y-1/2 items-center gap-1 rounded border border-border bg-muted/50 px-1 font-mono text-[9px] font-medium text-muted-foreground sm:inline-flex">
						⌘K
					</kbd>
				</div>
			</div>

			<div className="flex items-center justify-end gap-2">
				<button className="relative flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-hover-muted" type="button">
					<Inbox className="size-4" />
					<span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
						3
					</span>
				</button>
				<div className="mx-1 h-4 w-px bg-border" />
				<button className="flex size-8 items-center justify-center rounded-full" type="button">
					<span
						className="flex size-8 items-center justify-center rounded-full text-xs text-white"
						style={{ backgroundColor: viewer.color }}
					>
						{viewer.initials}
					</span>
				</button>
			</div>
		</header>
	);
}
