/**
 * Harbor's canonical schema.
 *
 * The one rule that shapes everything here: Harbor's own tables are the truth,
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
	integer,
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
 * service name. Harbor does not parse it in v1 and does not pretend to detect
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
		/**
		 * Why this work is being done, in the claimant's own words.
		 *
		 * The event log already records what changed and when; what it could never
		 * answer is why somebody started — the question asked six months later,
		 * usually by whoever has to decide whether a change can be reverted.
		 *
		 * Attached to the claim rather than the task on purpose: one task can be
		 * claimed three times for three different reasons, and the reason belongs
		 * to the attempt, not to the ticket.
		 */
		intent: text("intent"),
		/** A spec, design doc, thread or issue URL backing that intent. */
		intentRef: text("intent_ref"),
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
 * A room with work in it, and no owner.
 *
 * The failure mode this design exists to avoid is a session that belongs to one
 * person. Tie a session to a single author and "send it to a colleague and let
 * them take it home" becomes impossible to retrofit — every query, every
 * permission check and every UI affordance ends up assuming one identity, and
 * unpicking that later is a rewrite. So there is no `ownerId` column, and
 * `createdBy` exists purely as provenance: it records who opened the room and
 * confers nothing.
 *
 * `key` is the shareable half of the URL. Possession of the link is what grants
 * access — the same model as an unlisted document — because requiring an invite
 * for each participant is the friction that stops anyone sharing at all.
 */
export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** Short, URL-safe, unguessable. Appears in /s/<key>. */
		key: text("key").notNull(),
		title: text("title").notNull(),
		taskId: uuid("task_id").references(() => tasks.id),
		/** Provenance only. Deliberately NOT ownership. */
		createdBy: text("created_by").notNull(),
		status: text("status").notNull().default("open"),
		/**
		 * The next sequence number to hand out, incremented with RETURNING.
		 *
		 * A counter here rather than `max(seq) + 1` over the prompts table, because
		 * that subquery races: under READ COMMITTED two concurrent transactions
		 * cannot see one another's uncommitted rows, both compute the same maximum,
		 * and the unique index rejects the loser — dropping somebody's message in
		 * exactly the situation multiplayer exists to support. An UPDATE on this row
		 * takes a row lock, so the second transaction waits and gets the next value.
		 */
		nextSeq: integer("next_seq").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("sessions_key_idx").on(table.key),
		index("sessions_org_activity_idx").on(table.orgId, table.lastActivityAt),
	],
);

/** Everyone who has opened the link. Joining is the only membership event. */
export const sessionParticipants = pgTable(
	"session_participants",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		/** A human handle or an agent id — the room does not distinguish. */
		participant: text("participant").notNull(),
		kind: text("kind").notNull().default("human"),
		joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("participants_session_who_idx").on(table.sessionId, table.participant),
		index("participants_session_idx").on(table.sessionId),
	],
);

/**
 * Input from any client, queued rather than interleaved.
 *
 * Two decisions here, and both are corrections of the obvious design.
 *
 * `author` is required on every row. A session with several people steering has
 * to be able to answer "who asked for this?" months later, and attribution added
 * afterwards is attribution that is missing for everything already said.
 *
 * Prompts QUEUE instead of being injected the moment they arrive. When two people
 * type at once, splicing both into a running agent's context mid-turn produces
 * an agent following half of each instruction — the failure is silent and reads
 * as the model being stupid rather than as a race. A queue makes the ordering
 * explicit and lets a second thought arrive while the agent is still working on
 * the first, which is what people actually do.
 */
export const sessionPrompts = pgTable(
	"session_prompts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		/** Never nullable. Unattributed input is the thing this table exists to prevent. */
		author: text("author").notNull(),
		authorKind: text("author_kind").notNull().default("human"),
		body: text("body").notNull(),
		status: text("status").notNull().default("queued"),
		/** Monotonic within a session, so ordering never depends on timestamps. */
		seq: integer("seq").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("prompts_session_seq_idx").on(table.sessionId, table.seq),
		index("prompts_session_status_idx").on(table.sessionId, table.status),
	],
);

/**
 * Who is alive right now.
 *
 * Deliberately NOT a sixth MCP tool. Presence is a byproduct of the five calls an
 * agent already makes — every one touches this row — so an agent cannot forget to
 * report, does not opt in, and spends no extra tokens being visible. A heartbeat
 * tool was the obvious design and would have made every agent pay, on every turn,
 * for the dashboard's benefit.
 *
 * Liveness is computed at read time from `lastSeenAt` rather than stored as an
 * online flag, because a flag needs somebody to clear it and the agent that
 * crashed is precisely the one that will not.
 */
export const agentPresence = pgTable(
	"agent_presence",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		agentId: text("agent_id").notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastAction: text("last_action"),
		currentTaskId: uuid("current_task_id"),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("presence_org_agent_idx").on(table.orgId, table.agentId),
		index("presence_org_seen_idx").on(table.orgId, table.lastSeenAt),
	],
);

/**
 * An agent process Harbor started, as opposed to one that merely connected.
 *
 * Harbor does not own an execution sandbox and this is not the beginning of one. A
 * run is a child process on the host running the server, wired to Harbor's own MCP
 * endpoint — enough to launch work from the dashboard on a laptop or a single
 * box, and deliberately not enough to run somebody else's code. Multi-tenant
 * execution needs an isolation boundary bought from Modal or Daytona, not a
 * spawn() call, and pretending otherwise is how you ship an RCE.
 */
export const runs = pgTable(
	"runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		taskId: uuid("task_id").references(() => tasks.id),
		agentId: text("agent_id").notNull(),
		/** Which binary was launched: "claude-code" | "codex". */
		runtime: text("runtime").notNull(),
		prompt: text("prompt").notNull(),
		status: text("status").notNull().default("starting"),
		pid: text("pid"),
		exitCode: text("exit_code"),
		/** Combined stdout/stderr, bounded. Not a log pipeline. */
		output: text("output").notNull().default(""),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
	},
	(table) => [index("runs_org_started_idx").on(table.orgId, table.startedAt)],
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
export type HarborEvent = typeof events.$inferSelect;

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
