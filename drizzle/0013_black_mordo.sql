ALTER TABLE "session_prompts" ADD COLUMN "author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_resume_token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_resume_runtime" text;--> statement-breakpoint
ALTER TABLE "session_prompts" ADD CONSTRAINT "session_prompts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;