import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "../src/db/index.js";

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("migrations applied");
await sql.end();
