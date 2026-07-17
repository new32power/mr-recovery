import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db";
import { signMasterToken } from "../lib/jwt";

const router: IRouter = Router();

/* ── Rate limiter — per IP ── */
const RATE_MAX = 5;
const RATE_LOCKOUT_MS = 15 * 60 * 1000;
interface RateEntry { count: number; lockedUntil: number | null }
const rateLimitMap = new Map<string, RateEntry>();

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";
}
function checkRate(ip: string): { blocked: boolean; minutesLeft?: number } {
  const now = Date.now(); const e = rateLimitMap.get(ip);
  if (!e) return { blocked: false };
  if (e.lockedUntil && now < e.lockedUntil) return { blocked: true, minutesLeft: Math.ceil((e.lockedUntil - now) / 60_000) };
  if (e.lockedUntil && now >= e.lockedUntil) rateLimitMap.delete(ip);
  return { blocked: false };
}
function recordFailed(ip: string): void {
  const e = rateLimitMap.get(ip) ?? { count: 0, lockedUntil: null };
  e.count += 1;
  if (e.count >= RATE_MAX) e.lockedUntil = Date.now() + RATE_LOCKOUT_MS;
  rateLimitMap.set(ip, e);
}

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/auth/config
   Returns runtime config for the frontend — no rebuild needed to update values.
   Response: { googleClientId: string | null }
───────────────────────────────────────────────────────────────────────────── */
router.get("/auth/config", (_req, res) => {
  res.json({ googleClientId: process.env["GOOGLE_CLIENT_ID"] ?? null });
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/auth/google-verify
   Master admin login: frontend sends Google ID token (credential from GSI).
   Backend verifies via Google tokeninfo → checks email → issues master JWT.
   Response: { ok: true, token: <master JWT>, sessionId }
───────────────────────────────────────────────────────────────────────────── */
router.post("/auth/google-verify", async (req, res) => {
  const ip = getIp(req);
  const rate = checkRate(ip);
  if (rate.blocked) { res.status(429).json({ error: `Too many attempts. Try in ${rate.minutesLeft} min.` }); return; }

  const { credential } = req.body as { credential?: string };
  if (!credential) { res.status(400).json({ error: "credential required" }); return; }

  const allowedEmail = process.env["MASTER_ADMIN_EMAIL"];
  if (!allowedEmail) { res.status(503).json({ error: "MASTER_ADMIN_EMAIL not configured on server" }); return; }

  try {
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!infoRes.ok) { recordFailed(ip); res.status(401).json({ error: "Invalid Google token" }); return; }
    const info = await infoRes.json() as { email?: string; email_verified?: string };
    if (!info.email || info.email_verified !== "true") { recordFailed(ip); res.status(401).json({ error: "Google account not verified" }); return; }
    if (info.email.toLowerCase() !== allowedEmail.toLowerCase()) {
      recordFailed(ip);
      res.status(403).json({ error: "Access denied: this Google account is not authorized" });
      return;
    }
    const sessionId = randomUUID();
    const token = signMasterToken(sessionId, "8h");
    const ua = (req.headers["user-agent"] as string | undefined) ?? "";
    await pool.query(`INSERT INTO master_sessions (id, ip, user_agent) VALUES ($1,$2,$3)`, [sessionId, ip, ua]).catch(() => {});
    res.json({ ok: true, token, sessionId });
  } catch {
    res.status(500).json({ error: "Token verification failed. Try again." });
  }
});

/* ── POST /api/auth/logout — revoke master session ── */
router.post("/auth/logout", async (req, res) => {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const { verifyMasterToken } = await import("../lib/jwt");
      const payload = verifyMasterToken(token);
      if (payload.sessionId) {
        await pool.query(`DELETE FROM master_sessions WHERE id = $1`, [payload.sessionId]).catch(() => {});
      }
    } catch { /* invalid token — ignore */ }
  }
  res.json({ ok: true });
});

export default router;
