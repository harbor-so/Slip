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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express, { type Request, type Response } from "express";
import { orgIdForKey } from "../lib/auth.js";
import { sweepExpiredClaims } from "../lib/work.js";
import { toToolError, tools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 8787);
const SWEEP_INTERVAL_MS = 60_000;

export function buildServer(orgId: string): McpServer {
	const server = new McpServer(
		{ name: "slip", version: "0.1.0" },
		{
			instructions:
				"Slip coordinates multiple coding agents working the same backlog. Before " +
				"starting any work call list_work to see what is already claimed, then claim " +
				"the task you intend to do. Release it when you finish, with a summary.",
		},
	);

	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.schema },
			async (args: Record<string, unknown>) => {
				try {
					return { content: [{ type: "text" as const, text: await tool.run({ orgId }, args) }] };
				} catch (error) {
					// Returned as content with isError rather than thrown: the model has to
					// read "that task is held by someone else" and choose differently, and a
					// protocol-level exception is not something it can reason about.
					return {
						content: [{ type: "text" as const, text: toToolError(error) }],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}

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
	app.listen(PORT, () => {
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
