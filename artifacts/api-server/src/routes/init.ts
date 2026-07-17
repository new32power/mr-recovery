import { Router, type IRouter } from "express";
import { localDb } from "../lib/local-db";

const router: IRouter = Router();

/*
 * GET /api/init?appId=XXX[&limit=2000]
 * Returns devices + messages + formData in one shot (sub-admin dashboard load).
 * Auth: Bearer JWT (sub-admin or master) checked against stored session.
 */
router.get("/init", async (req, res) => {
  const appId = req.query.appId ? String(req.query.appId) : undefined;
  if (!appId) { res.status(400).json({ error: "appId is required" }); return; }

  const rawLimit = req.query.limit != null
    ? Math.max(0, Math.min(5000, parseInt(String(req.query.limit), 10) || 2000))
    : 2000;

  const [allDevices, allMessages, allFormData] = await Promise.all([
    localDb.listDevices({ appId }),
    localDb.listMessages({ appId }),
    localDb.listFormData({ appId }),
  ]);

  // Sort messages newest first, apply limit
  const messages = allMessages
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
    .slice(0, rawLimit);

  res.json({
    devices: allDevices,
    messages,
    formData: allFormData,
    totalMessages: allMessages.length,
  });
});

export default router;
