CREATE TABLE "agent_presence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_action" text,
	"current_task_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid,
	"agent_id" text NOT NULL,
	"runtime" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"pid" text,
	"exit_code" text,
	"output" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "intent_ref" text;--> statement-breakpoint
ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "presence_org_agent_idx" ON "agent_presence" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "presence_org_seen_idx" ON "agent_presence" USING btree ("org_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "runs_org_started_idx" ON "runs" USING btree ("org_id","started_at");