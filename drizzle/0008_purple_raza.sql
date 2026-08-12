ALTER TABLE "session_prompts" ADD COLUMN IF NOT EXISTS "author_email" text;--> statement-breakpoint
ALTER TABLE "session_prompts" ADD COLUMN IF NOT EXISTS "trace_id" text;