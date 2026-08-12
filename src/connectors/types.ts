/**
 * The provider boundary stays deliberately small so adding a connector costs
 * one implementation file rather than changes throughout webhook ingest.
 */

export interface Connector {
	type: "linear" | "github";
	verifyWebhook(
		rawBody: string,
		headers: Record<string, string | undefined>,
		secret: string,
	): boolean;
	handleWebhook(payload: unknown, orgId: string): Promise<WebhookResult>;
	syncOutbound?(taskId: string, orgId: string, summary: string): Promise<void>;
}

export type WebhookResult = {
	action: "created" | "updated" | "ignored";
	taskId?: string;
	reason?: string;
};
