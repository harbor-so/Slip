/**
 * Registry lookup is nullable because persisted connector rows can outlive an
 * implementation; stale configuration must not turn webhook ingest into a 500.
 */

import { githubConnector } from "./github.js";
import { linearConnector } from "./linear.js";
import type { Connector } from "./types.js";

export function connectorFor(type: string): Connector | null {
	if (type === "github") return githubConnector;
	if (type === "linear") return linearConnector;
	return null;
}
