/**
 * One connection, one place.
 *
 * `DATABASE_URL` is the only thing that changes between a local docker Postgres
 * and a hosted Supabase or Neon deployment — that is the whole of the
 * self-hosting story the README promises, and it stays true only if nothing
 * else in the codebase constructs its own client.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL ?? "postgres://slip:slip@localhost:5433/slip";

// `max: 1` in scripts avoids a pool that keeps the process alive after the work
// is done; the server path gets a real pool.
const isScript = process.env.SLIP_SINGLE_CONNECTION === "1";

export const sql = postgres(url, { max: isScript ? 1 : 10 });
export const db = drizzle(sql, { schema });
export { schema };
