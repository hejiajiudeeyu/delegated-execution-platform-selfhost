import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

async function readMigrationFiles(migrationsDir) {
  const names = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      version: name,
      sql: await fs.readFile(path.join(migrationsDir, name), "utf8")
    }))
  );
}

export async function createPostgresSnapshotStore({
  connectionString = null,
  serviceName,
  tableName = "service_state_snapshots",
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  pool = null
} = {}) {
  if (!serviceName) {
    throw new Error("postgres_store_service_name_required");
  }

  const ownsPool = !pool;
  const clientPool = pool || new Pool({ connectionString });

  async function query(text, params = []) {
    return clientPool.query(text, params);
  }

  async function migrate() {
    const migrations = await readMigrationFiles(migrationsDir);
    await query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT, applied_at TEXT)");

    for (const migration of migrations) {
      const existing = await query("SELECT version FROM schema_migrations WHERE version = $1", [migration.version]);
      if (existing.rowCount > 0) {
        continue;
      }

      const client = await clientPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [
          migration.version,
          new Date().toISOString()
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async function loadSnapshot() {
    const result = await query(`SELECT state_json FROM ${tableName} WHERE service_name = $1`, [serviceName]);
    return result.rows[0]?.state_json || null;
  }

  async function saveSnapshot(snapshot) {
    const updatedAt = new Date().toISOString();
    const client = await clientPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${tableName} WHERE service_name = $1`, [serviceName]);
      await client.query(`INSERT INTO ${tableName} (service_name, state_json, updated_at) VALUES ($1, $2::jsonb, $3)`, [
        serviceName,
        JSON.stringify(snapshot),
        updatedAt
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function close() {
    if (ownsPool) {
      await clientPool.end();
    }
  }

  return {
    migrate,
    loadSnapshot,
    saveSnapshot,
    close,
    pool: clientPool
  };
}
