import { Router, type IRouter } from "express";

const router: IRouter = Router();

/*
 * GET /api/tokens/:token
 * Verifies an APK access token via Firebase RTDB.
 */
router.get("/tokens/:token", async (req, res) => {
  const { token } = req.params;
  if (!token) { res.status(400).json({ status: "inactive", error: "token required" }); return; }

  const key = Buffer.from(token).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  try {
    const r = await fetch(
      `https://apkstore-ce547-default-rtdb.firebaseio.com/token_primary/${key}.json`
    );
    const data = await r.json() as { apkId?: number } | null;
    if (!data || typeof data !== "object" || !data.apkId) {
      res.status(404).json({ status: "inactive", error: "Token not registered" });
      return;
    }
    res.json({ status: "active", apkId: data.apkId });
  } catch {
    res.status(500).json({ status: "inactive", error: "Verification failed" });
  }
});

export default router;
