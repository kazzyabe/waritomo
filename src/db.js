import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

let pool;

export function isDatabaseEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

function databaseConfig() {
  if (!process.env.DATABASE_URL) return null;

  const config = {
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 5),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 3000),
  };

  if (process.env.CLOUD_SQL_CONNECTION_NAME) {
    const url = new URL(process.env.DATABASE_URL);
    config.connectionString = undefined;
    config.user = decodeURIComponent(url.username);
    config.password = decodeURIComponent(url.password);
    config.database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    config.host = `/cloudsql/${process.env.CLOUD_SQL_CONNECTION_NAME}`;
    config.port = 5432;
  }

  if (process.env.DB_SSL === "true") {
    config.ssl = { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" };
  }

  return config;
}

export function getPool() {
  if (!isDatabaseEnabled()) return null;
  if (!pool) pool = new Pool(databaseConfig());
  return pool;
}

export async function query(text, params = []) {
  const currentPool = getPool();
  if (!currentPool) throw new Error("DATABASE_URL is not configured");
  return currentPool.query(text, params);
}

export async function checkDatabaseAvailable() {
  if (!isDatabaseEnabled()) return false;
  try {
    await query("select 1");
    return true;
  } catch {
    return false;
  }
}

export async function withTransaction(callback) {
  const currentPool = getPool();
  if (!currentPool) throw new Error("DATABASE_URL is not configured");

  const client = await currentPool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateDatabase() {
  const schemaPath = join(fileURLToPath(new URL("..", import.meta.url)), "db/schema.sql");
  await query(await readFile(schemaPath, "utf8"));
}
