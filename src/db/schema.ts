/**
 * Slip's canonical schema.
 *
 * The one rule that shapes everything here: Slip's own tables are the truth,
 * always. Agents never talk to Linear or GitHub — they talk to these tables
 * through five MCP tools. Connectors are sync jobs that keep `tasks` fresh from
 * outside; they are not a layer agents reach through. That is what makes
 * external tools optional rather than load-bearing, and it is why `source` and
 * `source_ref` are ordinary columns on `tasks` rather than a separate join
 * table: a Linear issue and a hand-written task are the same kind of thing to
 * an agent, and the schema should not make an agent care which is which.
 */

import { relations, sql } from "drizzle-orm";
import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	orgId: uuid("org_id")
		.notNull()
		.references(() => orgs.id),
	githubId: text("github_id").unique(),
	email: text("email"),
	name: text("name"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One key per org, hashed.
 *
 * Stored as a SHA-256 hex digest with no salt. bcrypt exists to make an offline
 * search expensive, and a search needs a space small enough to walk — 256 bits
 * of CSPRNG output does not have one. A salt would also make the column
 * unindexable, turning authentication into a table scan on the hot path of
 * every single MCP call.
 */
export const apiKeys = pgTable("api_keys", {
	id: uuid("id").primaryKey().defaultRandom(),
	orgId: uuid("org_id")
		.notNull()
		.references(() => orgs.id),
	keyHash: text("key_hash").notNull().unique(),
	label: text("label"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const projects = pgTable("projects", {
	id: uuid("id").primaryKey().defaultRandom(),
	orgId: uuid("org_id")
		.notNull()
		.references(() => orgs.id),
	name: text("name").notNull(),
	description: text("description"),
	archivedAt: timestamp("archived_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `scope` is free text on purpose.
 *
 * It is a hint an agent writes about where the work lives — a path, a module, a
 * service name. Slip does not parse it in v1 and does not pretend to detect
 * semantic overlap from it; it is shown to the next agent so a human-shaped
 * judgement can be made cheaply. Structured file-level overlap detection is
 * explicitly future work, and making this column structured now would imply a
 * guarantee the product does not yet keep.
 */
export const tasks = pgTable(
	"tasks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		projectId: uuid("project_id").references(() => projects.id),
		title: text("title").notNull(),
		description: text("description"),
		status: text("status").notNull().default("open"),
		scope: text("scope"),
		source: text("source").notNull().default("native"),
		sourceRef: text("source_ref"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("tasks_org_status_idx").on(table.orgId, table.status),
		index("tasks_project_idx").on(table.projectId),
		// A connector re-delivering the same webhook must update the row it made
		// last time rather than add a second copy of the same Linear issue.
		uniqueIndex("tasks_source_ref_idx")
			.on(table.orgId, table.source, table.sourceRef)
			.where(sql`${table.sourceRef} is not null`),
	],
);

/**
 * The coordination primitive.
 *
 * The partial unique index is the entire mechanism: at most one row per task
 * with `released_at is null`. Two agents racing to claim the same task both
 * issue an INSERT, Postgres serialises them, and exactly one gets a unique
 * violation. The loser is not an error to swallow — it is a `claim_conflict`
 * event, and that event is the number the product is ultimately judged by.
 *
 * Note what the index does NOT cover: expiry. An expired-but-unreleased claim
 * still occupies the slot. That is deliberate — a partial index cannot depend
 * on `now()` — and it is why `claim()` lazily releases an expired holder inside
 * the same transaction before inserting. The sweeper is a backstop that keeps
 * the event log honest, not the thing correctness depends on.
 */
export const claims = pgTable(
	"claims",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id),
		agentId: text("agent_id").notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		completionSummary: text("completion_summary"),
	},
	(table) => [
		uniqueIndex("one_active_claim_per_task")
			.on(table.taskId)
			.where(sql`${table.releasedAt} is null`),
		index("claims_expiry_idx").on(table.expiresAt).where(sql`${table.releasedAt} is null`),
		index("claims_agent_idx").on(table.agentId),
	],
);

/**
 * Everything that happened. Append-only.
 *
 * Written in the same transaction as the state change it describes, so the log
 * cannot drift from reality: if a claim exists, its event exists. The weekly
 * digest is a read over this table rather than a separate analytics pipeline.
 */
export const events = pgTable(
	"events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		taskId: uuid("task_id").references(() => tasks.id),
		agentId: text("agent_id"),
		type: text("type").notNull(),
		payload: jsonb("payload"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("events_org_created_idx").on(table.orgId, table.createdAt),
		index("events_type_idx").on(table.orgId, table.type, table.createdAt),
	],
);

export const connectors = pgTable(
	"connectors",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		type: text("type").notNull(),
		/** OAuth tokens, workspace/repo ids, webhook secrets. Never sent to a client. */
		config: jsonb("config").notNull(),
		status: text("status").notNull().default("active"),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("connectors_org_type_idx").on(table.orgId, table.type),
		// A webhook arrives before we know which org it belongs to, so the
		// external account id has to be reachable by one indexed lookup.
		index("connectors_external_idx").on(table.type, table.status),
	],
);

export const digests = pgTable(
	"digests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
		periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
		body: text("body").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("digests_org_created_idx").on(table.orgId, table.createdAt)],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const orgsRelations = relations(orgs, ({ many }) => ({
	projects: many(projects),
	tasks: many(tasks),
	events: many(events),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
	org: one(orgs, { fields: [projects.orgId], references: [orgs.id] }),
	tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
	org: one(orgs, { fields: [tasks.orgId], references: [orgs.id] }),
	project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
	claims: many(claims),
}));

export const claimsRelations = relations(claims, ({ one }) => ({
	task: one(tasks, { fields: [claims.taskId], references: [tasks.id] }),
}));

export type Task = typeof tasks.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type SlipEvent = typeof events.$inferSelect;

/** Closed set. Every consumer switches on these, so they must not drift. */
export const EVENT_TYPES = [
	"task_created",
	"claimed",
	"released",
	"completed",
	"claim_conflict",
	"claim_expired",
	"claim_renewed",
	"connector_synced",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
