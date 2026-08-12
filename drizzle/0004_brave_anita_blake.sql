CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" uuid,
	"runtime" text NOT NULL,
	"runtime_session_id" text,
	"kind" text NOT NULL,
	"tool" text,
	"phase" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_org_created_idx" ON "activity" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_org_agent_idx" ON "activity" USING btree ("org_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_org_runtime_idx" ON "activity" USING btree ("org_id","runtime","created_at");