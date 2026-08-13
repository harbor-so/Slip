import type { Metadata } from "next";
import { currentSession } from "../lib/session.js";
import { listConnectors } from "../lib/dashboard.js";
import { Sidebar, type ConnectorStatus } from "@web/shell/Sidebar.js";
import "../styles/globals.css";

export const metadata: Metadata = {
	title: "Harbor",
	description: "Background coding agents your company can actually deploy.",
};

/**
 * The shell.
 *
 * A fixed left sidebar and one scrolling column. The server component does the
 * privileged reads — who the org is and what it is connected to — and hands them
 * to the client `Sidebar`, which owns the active-route highlight. The dashboard
 * is opened to answer "what happened" far more than to configure anything, which
 * is why the read surfaces lead the nav and the connected tools sit in the rail
 * rather than behind Settings.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
	const session = await currentSession();

	const connectors: ConnectorStatus[] = session
		? (await listConnectors(session.orgId)).map((row) => ({
				type: row.type,
				status: row.status,
				lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.getTime() : null,
			}))
		: [];

	return (
		<html className="dark" lang="en" suppressHydrationWarning>
			<body className="h-dvh bg-bg text-text">
				<div className="flex h-dvh">
					<Sidebar
						orgName={session ? session.orgName : null}
						devMode={Boolean(session?.unauthenticated)}
						connectors={connectors}
					/>

					<main className="min-w-0 flex-1 overflow-y-auto">
						{/* A dashboard that is silently unauthenticated is worse than one that
						    refuses to load, so the bypass announces itself on every page. */}
						{session?.unauthenticated ? (
							<div className="border-b border-border bg-primary/10 px-6 py-2 text-center text-xs text-foreground">
								Development mode — no GitHub OAuth configured, showing the first org. Set
								GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to require sign-in.
							</div>
						) : null}

						<div className="mx-auto max-w-5xl px-8 py-8">{children}</div>
					</main>
				</div>
			</body>
		</html>
	);
}
