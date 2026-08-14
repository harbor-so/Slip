"use client";

/**
 * The shell's sidebar.
 *
 * A fixed left rail: the places Harbor actually goes, then the connected tools
 * as a live list with real status. Every row here is a real page backed by the
 * database — the nav is the product's surface area, not a demo script. The
 * connected-tools list is read from the org's `connectors` rows, so "is GitHub
 * still connected?" is answerable from every screen.
 *
 * Client component because the active-route highlight needs the pathname; the
 * connector list and org identity come from the server layout.
 */

import {
	Activity,
	Anchor,
	FileText,
	Gauge,
	MessagesSquare,
	Plug,
	Settings,
	Sparkles,
	Terminal,
	Users,
	Workflow,
	type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/components/ui.js";
import { relTime } from "~/lib/format.js";

/**
 * The nav, ordered by how often somebody opens it — a dashboard for a system
 * that runs while you are not watching is opened to answer "what happened" far
 * more than to configure anything, so the read surfaces lead and Settings tails.
 */
const NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
	{ href: "/", label: "Activity", icon: Activity },
	{ href: "/channels", label: "Channels", icon: MessagesSquare },
	{ href: "/sessions", label: "Sessions", icon: Users },
	{ href: "/runs", label: "Runs", icon: Terminal },
	{ href: "/automations", label: "Automations", icon: Workflow },
	{ href: "/usage", label: "Usage", icon: Gauge },
	{ href: "/digest", label: "Digest", icon: FileText },
	{ href: "/connectors", label: "Connectors", icon: Plug },
	{ href: "/settings", label: "Settings", icon: Settings },
	{ href: "/demo", label: "Demo", icon: Sparkles },
];

const CONNECTOR_LABEL: Record<string, string> = {
	github: "GitHub",
	linear: "Linear",
	slack: "Slack",
	sentry: "Sentry",
};

export interface ConnectorStatus {
	type: string;
	status: string;
	lastSyncedAt: number | null;
}

export function Sidebar({
	orgName,
	devMode,
	connectors,
}: {
	orgName: string | null;
	devMode: boolean;
	connectors: ConnectorStatus[];
}) {
	const pathname = usePathname();

	return (
		<nav className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
			<Link href="/" className="flex h-14 items-center gap-2 px-4">
				<Anchor className="size-5 text-accent" />
				<span className="text-sm font-semibold tracking-tight">Harbor</span>
			</Link>

			<ul className="space-y-0.5 px-2">
				{NAV.map((item) => {
					// startsWith so a room (/c/…) keeps its section lit; "/" only matches
					// exactly or nothing would ever unlight.
					const active =
						item.href === "/"
							? pathname === "/"
							: pathname === item.href || pathname.startsWith(`${item.href}/`);
					const Icon = item.icon;
					return (
						<li key={item.href}>
							<Link
								href={item.href}
								className={cn(
									"flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
									active
										? "bg-raised text-text"
										: "text-muted hover:bg-raised/60 hover:text-text",
								)}
							>
								<Icon className="size-4" />
								{item.label}
							</Link>
						</li>
					);
				})}
			</ul>

			<div className="mt-6 flex min-h-0 flex-1 flex-col px-2">
				<p className="px-2.5 pb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
					Connected tools
				</p>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{connectors.length === 0 ? (
						<Link href="/connectors" className="block px-2.5 text-xs text-accent hover:underline">
							Connect your first tool
						</Link>
					) : (
						<ul className="space-y-0.5">
							{connectors.map((account) => (
								<li key={account.type}>
									<Link
										href="/connectors"
										className="flex items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-raised/60"
										title={account.type}
									>
										<span
											className={cn(
												"size-1.5 shrink-0 rounded-full",
												account.status === "connected" || account.status === "active"
													? "bg-good"
													: account.status === "error"
														? "bg-bad"
														: "bg-line-strong",
											)}
										/>
										<span className="truncate text-xs text-muted">
											{CONNECTOR_LABEL[account.type] ?? account.type}
										</span>
										<span className="nums ml-auto truncate text-[10px] text-faint">
											{account.status === "error"
												? "error"
												: account.lastSyncedAt
													? `${relTime(Date.now() - account.lastSyncedAt)} ago`
													: "never synced"}
										</span>
									</Link>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>

			<div className="border-t border-line p-3">
				<div className="flex items-center gap-2 rounded-xl px-1 py-1">
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
						{(orgName ?? "?").slice(0, 1).toUpperCase()}
					</span>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-text">{orgName ?? "No org"}</p>
						<p className="truncate text-xs text-muted">
							{devMode ? "dev mode — no sign-in" : "signed in"}
						</p>
					</div>
				</div>
			</div>
		</nav>
	);
}
