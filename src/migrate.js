import { migrateDatabase } from "./db.js";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

await migrateDatabase();
console.log("database schema applied");
