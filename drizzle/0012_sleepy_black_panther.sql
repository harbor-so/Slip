CREATE TABLE "devin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"devin_session_id" text NOT NULL,
	"session_id" uuid,
	"status" text DEFAULT 'working' NOT NULL,
	"last_status" text,
	"last_message_count" integer DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"pr_url" text,
	"pr_artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devin_sessions" ADD CONSTRAINT "devin_sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devin_sessions" ADD CONSTRAINT "devin_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devin_sessions" ADD CONSTRAINT "devin_sessions_pr_artifact_id_artifacts_id_fk" FOREIGN KEY ("pr_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devin_sessions_org_session_idx" ON "devin_sessions" USING btree ("org_id","devin_session_id");--> statement-breakpoint
CREATE INDEX "devin_sessions_poll_idx" ON "devin_sessions" USING btree ("status","last_polled_at");