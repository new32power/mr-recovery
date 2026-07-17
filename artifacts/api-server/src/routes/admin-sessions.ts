import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { requireJwt } from "../middlewares/requireJwt";
import { localDb } from "../lib/local-db";
import { signSubAdminToken } from "../lib/jwt";

export interface AdminSession {
  id: string;
  loginTime: string;
  lastActive: string;
  userAgent: string;
  ip: string;
  device: string;
  appId?: string;
  ghost?: boolean;
}

const sessions = new Map<string, AdminSession>();

function parseDevice(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown Device";
}

const router: IRouter = Router();

router.get("/admin/sessions", requireJwt, (_req, res) => {
  const list = Array.from(sessions.values())
    .filter(s => !s.ghost)
    .sort((a, b) => new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime());
  res.json(list);
});

/*
 * POST /api/admin/sessions
 * Sub-admin login: verify PIN, create session, return {sessionId, token}.
 * No master JWT required — this IS the login endpoint.
 */
router.post("/admin/sessions", async (req, res) => {
  const { appId, pin } = req.body as { appId?: string; pin?: string };
  if (!appId || !pin) { res.status(400).json({ error: "appId and pin required" }); return; }

  // Verify PIN
  const app = await localDb.getApp(appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  if (app.status !== "active") { res.status(403).json({ error: "App is disabled. Please contact admin." }); return; }

  const { verifyPin } = await import("../lib/hash");
  if (!verifyPin(pin, app.pin)) { res.status(401).json({ error: "Wrong PIN." }); return; }

  const ua = req.headers["user-agent"] ?? "";
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const now = new Date().toISOString();
  const session: AdminSession = {
    id: randomUUID(),
    loginTime: now,
    lastActive: now,
    userAgent: ua,
    ip,
    device: parseDevice(ua),
    appId,
  };
  sessions.set(session.id, session);

  // Issue sub-admin JWT (used for /api/recovery and other protected sub-admin routes)
  let token: string | undefined;
  try { token = signSubAdminToken(appId); } catch { token = undefined; }

  res.json({ sessionId: session.id, token });
});

router.post("/admin/sessions/ghost", requireJwt, (req, res) => {
  const ua = req.headers["user-agent"] ?? "";
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const now = new Date().toISOString();
  const session: AdminSession = {
    id: randomUUID(),
    loginTime: now,
    lastActive: now,
    userAgent: ua,
    ip,
    device: parseDevice(ua),
    ghost: true,
  };
  sessions.set(session.id, session);
  res.json({ sessionId: session.id });
});

router.patch("/admin/sessions/:id/ping", (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) {
    s.lastActive = new Date().toISOString();
    sessions.set(s.id, s);
  }
  res.json({ ok: true });
});

router.delete("/admin/sessions/:id", requireJwt, (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

router.delete("/admin/sessions", requireJwt, (req, res) => {
  const { appId } = req.query;
  if (appId) {
    for (const [id, s] of sessions) {
      if (s.appId === String(appId)) sessions.delete(id);
    }
  } else {
    sessions.clear();
  }
  res.json({ ok: true });
});

export default router;
