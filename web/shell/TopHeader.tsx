"use client";

/**
 * The top titlebar: the org on the left, a search field in the middle, and the
 * signed-in identity on the right. Org and identity are the real values handed
 * down from the server layout — the org's name and the viewer, not a fixture.
 */

import { ChevronsUpDown, Search } from "lucide-react";

function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	const first = parts[0]![0] ?? "";
	const second = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
	return (first + second).toUpperCase();
}

export function TopHeader({ orgName, userName }: { orgName: string; userName: string }) {
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
					<span className="max-w-[140px] truncate">{orgName}</span>
					<ChevronsUpDown className="size-3 shrink-0 opacity-50" />
				</button>
			</div>

			<div className="hidden md:block">
				<div className="relative w-48 lg:w-72">
					<Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						className="h-7 w-full rounded-md border border-border bg-card pr-12 pl-9 text-xs outline-none placeholder:text-muted-foreground"
						placeholder="Search…"
					/>
					<kbd className="absolute top-1/2 right-2 hidden h-4 -translate-y-1/2 items-center gap-1 rounded border border-border bg-muted/50 px-1 font-mono text-[9px] font-medium text-muted-foreground sm:inline-flex">
						⌘K
					</kbd>
				</div>
			</div>

			<div className="flex items-center justify-end">
				<button
					className="flex size-8 items-center justify-center rounded-full"
					title={userName}
					type="button"
				>
					<span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
						{initialsOf(userName)}
					</span>
				</button>
			</div>
		</header>
	);
}
