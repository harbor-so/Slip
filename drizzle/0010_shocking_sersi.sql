-- Generalise the claim into a scoped, org-owned, rights-bearing lease.
--
-- Hand-edited from the drizzle-generated diff so it is safe on existing rows:
-- the new NOT NULL columns are added nullable, backfilled from `tasks`, and only
-- then constrained. A generated "ADD COLUMN ... NOT NULL" would abort against any
-- existing claim.

-- 1. task_id is no longer load-bearing for the invariant; it may be null for a
--    lease over a scope that has no task row.
ALTER TABLE "claims" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint

-- 2. New columns, added nullable (or with a default) so the backfill can run.
ALTER TABLE "claims" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "rights" text[] DEFAULT '{read,write}' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "parent_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_parent_lease_id_claims_id_fk" FOREIGN KEY ("parent_lease_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 3. Backfill org and scope from the task each existing claim was over. A Linear
--    task leases its external identity so a claim here collides with one taken by
--    an agent talking to Linear directly; everything else leases its Harbor id.
UPDATE "claims" c
SET "org_id" = t."org_id",
    "scope" = CASE
        WHEN t."source" = 'linear' AND t."source_ref" IS NOT NULL
            THEN 'linear:' || t."source_ref"
        ELSE 'harbor:' || t."id"::text
    END
FROM "tasks" t
WHERE c."task_id" = t."id";--> statement-breakpoint

-- 4. Intent is required going forward; existing claims that predate the rule get
--    an honest placeholder rather than a fabricated reason.
UPDATE "claims" SET "intent" = 'legacy claim: no intent was recorded' WHERE "intent" IS NULL;--> statement-breakpoint

-- 5. Now the columns can be constrained.
ALTER TABLE "claims" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "intent" SET NOT NULL;--> statement-breakpoint

-- 6. Swap the uniqueness invariant from the task row to the scope-within-org.
DROP INDEX "one_active_claim_per_task";--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_lease_per_scope" ON "claims" USING btree ("org_id","scope") WHERE "claims"."released_at" is null;--> statement-breakpoint
CREATE INDEX "claims_org_idx" ON "claims" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "claims_parent_idx" ON "claims" USING btree ("parent_lease_id");
