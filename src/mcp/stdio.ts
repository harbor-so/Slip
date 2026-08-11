/**
 * stdio transport, for self-hosting and local development.
 *
 * Same tools, same code path — this file only swaps how bytes move. The org
 * comes from SLIP_API_KEY in the environment rather than a header, because a
 * stdio server has no request to carry one.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { orgIdForKey } from "../lib/auth.js";
import { buildServer } from "./server.js";

const orgId = await orgIdForKey(process.env.SLIP_API_KEY);
if (!orgId) {
	// stderr, never stdout: stdout is the JSON-RPC channel and a stray line there
	// corrupts the protocol for the client.
	console.error("SLIP_API_KEY is missing or invalid.");
	process.exit(1);
}

await buildServer(orgId).connect(new StdioServerTransport());
