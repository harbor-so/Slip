/**
 * The MCP server, over Streamable HTTP.
 *
 * HTTP rather than stdio is the deployment decision that makes Slip a shared
 * service instead of a per-laptop tool: one hosted URL and one API key per team,
 * pasted into every agent's config, so a Conductor worktree spun up at 2am sees
 * the same task list as an engineer's local Claude Code. A stdio fallback lives
 * in stdio.ts for self-hosting and local development, and both wrap the same
 * tool definitions — there is no second implementation to drift.
 *
 * Auth is a bearer token that names no org. The org is read off the row the
 * digest matched, so a request can prove which key it holds but cannot assert
 * which tenant it belongs to.
 *
 * Sessions are deliberately not persisted. Each request builds a transport in
 * stateless mode, which means any process can serve any request and a restart
 * loses nothing. Slip has no per-session state worth keeping — a claim lives in
 * Postgres, not in a socket.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { orgIdForKey } from "../lib/auth.js";
import { sweepExpiredClaims } from "../lib/work.js";
import { buildServer } from "./build.js";
import { tools } from "./tools.js";

export { buildServer };

/**
 * The port every doc, the Settings page and scripts/agents.ts already name.
 *
 * This was 8787 while six other references said 8788 and nothing set PORT, so
 * the documented happy path — `npm run mcp`, paste the Settings snippet — was
 * ECONNREFUSED on the first tool call. Exported so the other call sites derive
 * from it instead of restating it.
 */
export const DEFAULT_MCP_PORT = 8788;
const PORT = Number(process.env.PORT ?? DEFAULT_MCP_PORT);
const SWEEP_INTERVAL_MS = 60_000;


const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
	res.json({ ok: true, tools: tools.map((t) => t.name) });
});

app.all("/mcp", async (req: Request, res: Response) => {
	const orgId = await orgIdForKey(req.header("authorization"));
	if (!orgId) {
		res.status(401).json({
			jsonrpc: "2.0",
			error: { code: -32001, message: "Missing or invalid API key." },
			id: null,
		});
		return;
	}

	// `sessionIdGenerator: undefined` is the SDK's stateless mode, and it is
	// required rather than merely tidy: a new transport is built per request, so a
	// session id would be issued and then immediately forgotten, and every call
	// after `initialize` would be refused with "Server not initialized".
	//
	// Stateless is also the right shape for Slip. A claim lives in Postgres, not
	// in a socket, so any process can serve any request and a restart loses
	// nothing — which is what lets this run behind a load balancer as one hosted
	// URL for a whole team.
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	const server = buildServer(orgId);

	// Both ends are per-request, so the sockets must be closed with the request or
	// a long-running server leaks a transport per call.
	res.on("close", () => {
		void transport.close();
		void server.close();
	});

	await server.connect(transport);
	await transport.handleRequest(req, res, req.body);
});

if (process.env.NODE_ENV !== "test") {
	// Loopback by default. The previous `listen(PORT)` bound every interface, which
	// on a laptop on a shared network exposes an endpoint whose only auth is a
	// bearer token, to anyone who can reach the host. Set HOST=0.0.0.0 to publish
	// it deliberately.
	app.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
		console.log(`slip mcp on http://localhost:${PORT}/mcp`);
		console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
	});

	// The sweeper is a backstop, not the mechanism — claim() already expires a
	// stale holder before inserting. What this adds is timeliness, so a task whose
	// agent died reads as open in the dashboard within a minute.
	setInterval(() => {
		sweepExpiredClaims()
			.then((n) => {
				if (n > 0) console.log(`[sweep] released ${n} expired claim(s)`);
			})
			.catch((error) => console.error("[sweep] failed:", error));
	}, SWEEP_INTERVAL_MS).unref();
}

export { app };
