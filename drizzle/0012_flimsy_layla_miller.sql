CREATE TABLE "image_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"commit_sha" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"failure_reason" text,
	"log_location" text
);
--> statement-breakpoint
CREATE TABLE "repo_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"image_ref" text,
	"built_from_sha" text,
	"built_at" timestamp with time zone,
	"built_by_provider" text,
	"next_build_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_builds" ADD CONSTRAINT "image_builds_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_builds" ADD CONSTRAINT "image_builds_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_images" ADD CONSTRAINT "repo_images_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_images" ADD CONSTRAINT "repo_images_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_builds_repo_idx" ON "image_builds" USING btree ("repo_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_build_per_repo" ON "image_builds" USING btree ("repo_id") WHERE "image_builds"."finished_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_images_repo_idx" ON "repo_images" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "repo_images_due_idx" ON "repo_images" USING btree ("next_build_at");