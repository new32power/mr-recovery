import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
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

let initPromise: Promise<void> | null = null;

export function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // Only test connectivity — do NOT create/alter/drop any tables or insert seed data.
      await pool.query("SELECT 1");
      logger.info("Postgres connected ✓");
    })().catch((err) => {
      logger.error({ err }, "Postgres connection failed");
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}
