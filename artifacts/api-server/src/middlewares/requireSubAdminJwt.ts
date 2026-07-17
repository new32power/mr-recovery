import type { Request, Response, NextFunction } from "express";
import { verifySubAdminToken } from "../lib/jwt";

/**
 * Accepts sub-admin JWTs (role: "sub-admin").
 * Attaches req.subAdminAppId for downstream handlers.
 */
export function requireSubAdminJwt(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header missing or invalid" });
    return;
  }
  const token = auth.slice(7);
  try {
    const payload = verifySubAdminToken(token);
    (req as Request & { subAdminAppId?: string }).subAdminAppId = payload.appId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
