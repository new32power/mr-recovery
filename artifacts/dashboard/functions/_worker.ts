/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
}

/** Render backend — all /api/* requests go here */
const BACKEND = "https://mr-recovery-api-502z.onrender.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,x-master-pin,x-master-session,x-api-key,x-session-token,x-silent",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Background warm-up: keep Render awake (fire-and-forget) ──────────
    // Only trigger on non-API page loads to avoid recursion
    if (!url.pathname.startsWith("/api/") && request.headers.get("Upgrade") !== "websocket") {
      (async () => {
        try { await fetch(BACKEND + "/api/health", { signal: AbortSignal.timeout(3000) }); } catch { /* ok */ }
      })();
    }

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── /api/auth/config — served directly from CF (not proxied to Render) ──
    if (url.pathname === "/api/auth/config" && request.method === "GET") {
      const clientId = env.GOOGLE_CLIENT_ID ?? "461863915234-r9tvbtn7kr2pm9hpebmj301nrv6bg03h.apps.googleusercontent.com";
      return new Response(
        JSON.stringify({ googleClientId: clientId }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
      );
    }

    // ── /api/notice — public notice ticker (stub if Render not ready) ──────
    if (url.pathname === "/api/notice" && request.method === "GET") {
      const resp = await fetch(BACKEND + "/api/notice").catch(() => null);
      if (resp && resp.ok) {
        const headers = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(resp.body, { status: 200, headers });
      }
      return new Response(JSON.stringify({ notices: [] }), {
        status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // ── /api/master/ping — session keepalive (always ok, logout prevented) ─
    if (url.pathname === "/api/master/ping" && request.method === "POST") {
      const resp = await fetch(BACKEND + "/api/master/ping", {
        method: "POST", headers: request.headers,
      }).catch(() => null);
      if (resp && resp.status !== 404) {
        const headers = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(resp.body, { status: resp.status, headers });
      }
      // Render not ready yet — return ok so panel stays logged in
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // ── /api/master/stats — fallback stub if Render not ready ────────────
    if (url.pathname === "/api/master/stats" && request.method === "GET") {
      const resp = await fetch(BACKEND + "/api/master/stats", { headers: request.headers }).catch(() => null);
      if (resp && resp.status !== 404) {
        const headers = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(resp.body, { status: resp.status, headers });
      }
      return new Response(JSON.stringify({
        onlineCount: 0, totalDevices: 0, totalApps: 0,
        activeApps: 0, appsToday: 0, totalMessages: 0,
        messagesToday: 0, activeSessions: 0,
      }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

    // ── /api/master/sse-token — fallback stub if Render not ready ────────
    if (url.pathname === "/api/master/sse-token" && request.method === "POST") {
      const resp = await fetch(BACKEND + "/api/master/sse-token", {
        method: "POST", headers: request.headers, body: request.body,
      }).catch(() => null);
      if (resp && resp.status !== 404) {
        const headers = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(resp.body, { status: resp.status, headers });
      }
      // Return 503 so frontend retries later when Render is ready
      return new Response(JSON.stringify({ error: "SSE service starting up, retry soon" }), {
        status: 503, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // ── WebSocket upgrade — accept in Worker, relay events from Render SSE ─
    if (request.headers.get("Upgrade") === "websocket") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { 0: client, 1: server } = new (globalThis as any).WebSocketPair() as {
        0: WebSocket; 1: WebSocket;
      };
      // @ts-expect-error — CF Workers non-standard
      server.accept();
      // Send initial connected ping so browser shows "Live"
      server.send(JSON.stringify({ event: "ping", data: { t: Date.now() } }));
      // Keep-alive: pong back any message from client
      server.addEventListener("message", (_e: MessageEvent) => {
        try { server.send(JSON.stringify({ event: "pong", data: { t: Date.now() } })); } catch { /* ok */ }
      });
      // @ts-expect-error — CF Workers non-standard response field
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Proxy /api/* → Render backend ─────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      const backendUrl = BACKEND + url.pathname + url.search;

      const proxyReq = new Request(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "follow",
      });

      try {
        const resp = await fetch(proxyReq);
        const headers = new Headers(resp.headers);
        // Ensure CORS headers on every API response
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      } catch {
        return new Response(JSON.stringify({ error: "Backend unreachable" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // ── Static assets from Cloudflare Pages ───────────────────────────────
    const resp = await env.ASSETS.fetch(request);

    // SPA fallback: non-asset 404 → serve index.html
    if (resp.status === 404) {
      const isAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|txt|xml)$/i.test(
        url.pathname,
      );
      if (!isAsset) {
        return env.ASSETS.fetch(
          new Request(new URL("/index.html", request.url).toString(), {
            headers: request.headers,
          }),
        );
      }
    }

    return resp;
  },
};
