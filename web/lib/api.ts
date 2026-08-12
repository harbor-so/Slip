/**
 * The browser's thin door to Harbor's REST API.
 *
 * Every call is same-origin and rides the `harbor_session` cookie
 * (`credentials: "include"`), because the whole frontend is served by the same
 * Next.js process that serves `/api/*` — there is no cross-origin story and no
 * token to attach. This is deliberately tiny: chat's write path goes through the
 * signing SDK (`ChatClient`), not here, because posting requires a key the server
 * must never hold. What lives here is the read side and the non-signed actions
 * (runs, sessions, automations) that a session cookie alone authorises.
 */

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.body) headers.set("content-type", "application/json");
	const response = await fetch(path, { ...init, headers, credentials: "include" });
	const data = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? `${path} failed (${response.status})`);
	return data;
}

export const api = {
	get: <T>(path: string) => request<T>(path),
	post: <T>(path: string, body?: unknown) =>
		request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
};

// -- Channels (read side; writes go through ChatClient) ----------------------

export interface ChannelSummary {
	id: string;
	key: string;
	kind: string;
	title: string;
	lastActivityAt: string;
	/** Present when the server can compute it for the caller. */
	unread?: number;
}

export function listChannels(as?: string): Promise<{ channels: ChannelSummary[] }> {
	const query = as ? `?as=${encodeURIComponent(as)}` : "";
	return api.get(`/api/channels${query}`);
}

// -- Runs --------------------------------------------------------------------

export interface RunRow {
	id: string;
	agentId: string;
	runtime: string;
	status: string;
	prompt: string;
	/** Combined stdout/stderr, bounded server-side. Never null (defaults to ""). */
	output: string;
	pid: string | null;
	/** Stored as text in the schema, so it arrives as a string. */
	exitCode: string | null;
	taskId: string | null;
	startedAt: string;
	endedAt: string | null;
}

export function listRuns(): Promise<{ runs: RunRow[] }> {
	return api.get("/api/runs");
}

export function launchRun(input: {
	runtime: string;
	prompt: string;
	taskId?: string;
	agentId?: string;
}): Promise<{ runId: string }> {
	return api.post("/api/runs", input);
}

// -- Sessions ----------------------------------------------------------------

export interface SessionRow {
	id: string;
	key: string;
	title: string;
	status: string;
	createdAt: string;
	lastActivityAt: string;
}

export function listSessions(): Promise<{ sessions: SessionRow[] }> {
	return api.get("/api/sessions");
}

export function queuePrompt(key: string, prompt: string): Promise<unknown> {
	return api.post(`/api/sessions/${key}/prompts`, { prompt });
}

// -- Automations -------------------------------------------------------------

export interface AutomationRow {
	id: string;
	name: string;
	source: string;
	enabled: boolean;
	pausedReason: string | null;
	lastFiredAt: string | null;
}

export function listAutomations(): Promise<{ automations: AutomationRow[] }> {
	return api.get("/api/automations");
}

export function runAutomation(id: string): Promise<unknown> {
	return api.post(`/api/automations/${id}/run`);
}

export function resumeAutomation(id: string): Promise<unknown> {
	return api.post(`/api/automations/${id}/resume`);
}
