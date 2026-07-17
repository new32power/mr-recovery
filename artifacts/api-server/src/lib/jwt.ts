import jwt from "jsonwebtoken";

function getSecret(): string {
  const s = process.env["JWT_SECRET"];
  if (!s) throw new Error("JWT_SECRET env var is not set");
  return s;
}

// ── Master token ──────────────────────────────────────────────────────────────
export interface MasterPayload {
  role: "master";
  sessionId: string;
  iat?: number;
  exp?: number;
}

export function signMasterToken(sessionId: string, expiresIn = "8h"): string {
  return jwt.sign(
    { role: "master", sessionId } as MasterPayload,
    getSecret(),
    { expiresIn } as jwt.SignOptions
  );
}

export function verifyMasterToken(token: string): MasterPayload {
  return jwt.verify(token, getSecret()) as MasterPayload;
}

// ── Sub-admin token (per-app) ─────────────────────────────────────────────────
export interface SubAdminPayload {
  role: "sub-admin";
  appId: string;
  iat?: number;
  exp?: number;
}

export function signSubAdminToken(appId: string, expiresIn = "24h"): string {
  return jwt.sign(
    { role: "sub-admin", appId } as SubAdminPayload,
    getSecret(),
    { expiresIn } as jwt.SignOptions
  );
}

export function verifySubAdminToken(token: string): SubAdminPayload {
  const payload = jwt.verify(token, getSecret()) as SubAdminPayload;
  if (payload.role !== "sub-admin") throw new Error("Not a sub-admin token");
  return payload;
}

// ── Generic verify (returns either payload) ───────────────────────────────────
export function verifyAnyToken(token: string): MasterPayload | SubAdminPayload {
  return jwt.verify(token, getSecret()) as MasterPayload | SubAdminPayload;
}
